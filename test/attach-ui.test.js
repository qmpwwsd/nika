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
  MAX_FILES, MAX_BYTES, formatSize, shownName, uploadView, sendView, typeIcon, createAttachTray, isSecretName,
} from '../public/attach.js';
import { isSecretName as serverIsSecretName } from '../src/attachments.js';
import { installDom, El, focus } from './fake-dom.js';
import { icon } from '../public/dom.js';

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

  after(node) { this.afterNode = node; } // ChildNode.after: the one node attach.js puts beside the tray

  contains(node) { // Node.contains: this element or any of its descendants
    for (let n = node; n; n = n.parent) if (n === this) return true;
    return false;
  }
}

const tick = () => new Promise((resolve) => { setImmediate(resolve); });
const settle = async () => { for (let i = 0; i < 5; i += 1) await tick(); };
const file = (name, size = 1000) => ({ name, size, type: '' });
const screenOf = (over = {}) => ({ state: 'empty', mode: 'prompt', text: '', sig: SIG, box: { top: 0, bottom: 2 }, cursorAtEnd: true, suggestion: null, ...over });
const uploadId = (n) => `00000000000000${String(n).padStart(2, '0')}`;
const typeOf = (name) => (/\.png$/.test(name) ? 'png' : /\.pdf$/.test(name) ? 'pdf' : 'text');
const isUpload = (p, o) => o.method === 'POST' && /\/attachments$/.test(p);
const isSend = (p, o) => o.method === 'POST' && /\/attach-send$/.test(p);
const REQ = '11111111-1111-4111-8111-111111111111';
const isPickStart = (p, o) => o.method === 'POST' && /\/attachments\/pick$/.test(p);
const isPickPoll = (p, o) => o.method === 'GET' && /\/attachments\/pick\/[0-9a-f-]{36}$/.test(p);
const isPickStartCall = (c) => c.method === 'POST' && /\/attachments\/pick$/.test(c.path);
const sends = (r) => r.log.calls.filter((c) => c.path.endsWith('attach-send'));
const deletes = (r) => r.log.calls.filter((c) => c.method === 'DELETE');
const icons = (node) => node.all(() => true).filter((n) => n.tag === 'use').map((n) => n.attrs.href);

let current = null;
afterEach(() => { current?.(); current = null; });

/** A page with the ids attach.js looks up, and the io session.js gives createAttachTray. `reply(path, opts)` scripts a route answer. */
function rig(opts = {}) {
  current?.(); // one page at a time: a second rig in a test starts from a clean document
  const els = {};
  for (const [id, tag] of [['att-tray', 'ul'], ['att-btn', 'button'], ['att-drop', 'span'], ['composer-box', 'div'], ['composer', 'textarea'], ['send', 'button']]) els[id] = new TEl(tag);
  els['att-tray'].hidden = true;
  els['att-drop'].hidden = true;
  els['att-btn'].setAttribute('aria-label', 'Add attachments'); // as session.html has it
  const docListeners = {};
  const restoreDom = installDom({ getElementById: (id) => els[id] ?? null, addEventListener: (t, fn) => { (docListeners[t] ??= []).push(fn); } });
  els['att-btn'].append(icon('attach')); // the paperclip session.html draws
  const savedWindow = globalThis.window;
  globalThis.window = new TEl('window');
  current = () => { restoreDom(); globalThis.window = savedWindow; };
  const doc = (type, extra = {}) => {
    const e = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const fn of docListeners[type] ?? []) fn(e);
    return e;
  };
  const log = { calls: [], say: [], announce: [], problem: [], notice: [], gone: 0, ds: [], clear: [], order: [], focus: 0, jobs: 0, sleeps: [] };
  const state = { screen: opts.screen === undefined ? screenOf() : opts.screen, shell: false, pushed: null, sentReply: null, n: 0, pickStart: null, polls: [], gate: null };
  const reply = opts.reply ?? ((p, o) => {
    if (isUpload(p, o)) {
      state.n += 1;
      return { status: 200, body: { id: uploadId(state.n), type: typeOf(o.json.name), size: 123 } };
    }
    if (isSend(p, o)) return state.sentReply ?? { status: 200, body: { sent: o.json.ids.length, images: 0 } };
    if (isPickStart(p, o)) return state.pickStart ?? { status: 202, body: { reqId: REQ } };
    if (isPickPoll(p, o)) { // state.polls = the answers in order, the last one repeats; state.gate holds every poll back until it resolves
      const next = () => (state.polls.length > 1 ? state.polls.shift() : state.polls[0] ?? { status: 200, body: { state: 'cancelled' } }); // never pending by default: the fake sleep is instant
      return state.gate ? state.gate.then(next) : next();
    }
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
        return { ok: true, sig: SIG2 };
      },
      beginSend: () => log.ds.push(['begin']),
      endSend: () => log.ds.push(['end']),
      submitted: (r) => { log.ds.push(['submitted', r.status, r.body?.draft ?? null]); log.order.push('submitted'); },
    },
    enqueueJob: (run) => { log.jobs += 1; return Promise.resolve().then(run); },
    say: (m) => log.say.push(m),
    announce: (m) => log.announce.push(m),
    showProblem: (m, kind, ms) => log.problem.push([m, kind, ms]),
    clearProblem: () => log.problem.push(['']),
    showNotice: (m) => log.notice.push(m),
    setGone: () => { log.gone += 1; },
    box: () => ({ value: '', shell: state.shell }),
    cols: () => 120,
    clearBox: (v) => { log.clear.push(v); log.order.push('clearBox'); },
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
    add: async (...fs) => { els.composer.fire('paste', { clipboardData: { files: fs } }); await settle(); }, // files in, the way a paste brings them
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

  test('(+) M4: a credential file (.env, .env.*, *.key, *.pem) has its fixed chip word and line', () => {
    assert.deepEqual(v(400, 'secret-file', '.env'), { short: 'Not attached', line: "nika doesn't attach .env, key or certificate files." });
    assert.deepEqual(v(400, 'secret-file', 'x.pem'), v(400, 'secret-file', 'other.key'), 'the line does not echo the name');
  });

  test('(−) M4: secret-file is read only as a 400; the server\'s own text never shows', () => {
    for (const s of [0, 200, 409, 415, 429, 507]) assert.deepEqual(v(s, 'secret-file'), { short: 'Upload failed', line: null }, String(s)); // (a 413 is "Too big" whatever its code, as before)
    assert.doesNotMatch(JSON.stringify(uploadView({ status: 400, code: 'secret-file', message: 'SERVER SAID THIS /secret/path' }, 'a.key')), /SERVER|secret\/path/);
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
    assert.equal(s(409, 'not-idle').line, 'A prompt is open in Claude or Stop is running. Nothing was sent; your text and attachments are kept.');
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
    assert.equal(s(409, 'not-idle', { pasted: 3 }).line, `nika put 3 of 3 attachments into Claude's input, then stopped without pressing Enter: a prompt opened or Stop ran.${tail}`);
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

  // M4 (rule 4): the tray never reads a credential file. The name decides, so FileReader is never called and nothing is posted.
  test('(−) M4: a pasted or dropped .env, .env.*, *.key or *.pem file is a failed chip "Not attached": no read, no request, the fixed line', async () => {
    for (const name of ['.env', '.ENV', '.env.production', 'server.key', 'CERT.PEM', 'dir/.env']) {
      let reads = 0;
      const r = rig({ read: async () => { reads += 1; return 'QUJD'; } });
      await r.add(file(name));
      assert.equal(reads, 0, `${name}: never read`);
      assert.equal(r.log.calls.length, 0, `${name}: no request`);
      assert.deepEqual([view(r.chips()[0]).s, view(r.chips()[0]).meta], ['failed', 'Not attached'], name);
      assert.deepEqual(r.log.problem.at(-1), ["nika doesn't attach .env, key or certificate files.", 'error', 8000], name);
    }
  });

  // F3 (owner answer 2026-11-15): the same refusal, before any request, for .envrc, the keystores and the SSH private keys.
  // Fix round 1 (orchestrator ruling): .envrc.* is refused like .env.* (.envrc.dev, .envrc.bak, .envrc. ...).
  const NEW_KINDS = ['.envrc', '.envrc.dev', '.envrc.bak', '.envrc.', 'cert.p12', 'cert.pfx', 'store.jks', 'app.keystore', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk'];
  const mixedCase = (n) => [...n].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join('');

  test('(−) F3: a pasted or dropped .envrc, *.p12, *.pfx, *.jks, *.keystore or SSH private key (any case, with a path in front) is "Not attached": no read, no request, the same fixed line', async () => {
    for (const kind of NEW_KINDS) {
      for (const name of [kind, kind.toUpperCase(), mixedCase(kind), `/x/y/${kind.toUpperCase()}`]) {
        let reads = 0;
        const r = rig({ read: async () => { reads += 1; return 'QUJD'; } });
        await r.add(file(name));
        assert.equal(reads, 0, `${name}: never read`);
        assert.equal(r.log.calls.length, 0, `${name}: no request`);
        assert.deepEqual([view(r.chips()[0]).s, view(r.chips()[0]).meta], ['failed', 'Not attached'], name);
        assert.deepEqual(r.log.problem.at(-1), ["nika doesn't attach .env, key or certificate files.", 'error', 8000], name);
      }
    }
  });

  test('(+) F3: a public key and the look-alikes of the new kinds are read and uploaded as before', async () => {
    const names = ['id_rsa.pub', 'id_ed25519.pub', 'id_rsa_backup.txt', 'my.keystore.md', 'notes.envrc.txt', 'p12.txt'];
    let reads = 0;
    const r = rig({ read: async () => { reads += 1; return 'QUJD'; } });
    await r.add(...names.map((n) => file(n)));
    assert.equal(reads, names.length);
    assert.equal(r.log.calls.length, names.length);
    assert.deepEqual(r.chips().map((li) => view(li).s), names.map(() => 'ready'));
  });

  test('(+) fix round 1: envrc.dev, my.envrc.dev, .envrcx and .envrc-old are read and uploaded as before (only .envrc and .envrc.* are refused)', async () => {
    const names = ['envrc.dev', 'my.envrc.dev', '.envrcx', '.envrc-old'];
    let reads = 0;
    const r = rig({ read: async () => { reads += 1; return 'QUJD'; } });
    await r.add(...names.map((n) => file(n)));
    assert.equal(reads, names.length);
    assert.equal(r.log.calls.length, names.length);
    assert.deepEqual(r.chips().map((li) => view(li).s), names.map(() => 'ready'));
  });

  test('(+) M4: an ordinary file next to a secret one still uploads, in order', async () => {
    let reads = 0;
    const r = rig({ read: async () => { reads += 1; return 'QUJD'; } });
    await r.add(file('.env'), file('notes.md'), file('keys.md'));
    assert.equal(reads, 2);
    assert.deepEqual(r.chips().map((li) => view(li).s), ['failed', 'ready', 'ready']);
    assert.equal(r.log.calls.length, 2);
  });

  test('(+) M4: the page\'s name pattern and the server\'s agree on every name of the table (a copy that drifts fails here)', () => {
    const names = ['.env', '.ENV', '.env.dev', '.env.', 'dir/.env', 'C:\\p\\.env', 'server.key', 'SERVER.KEY', 'id.pem', 'cert.PEM', '.key', '.pem', 'x.key ', 'multi\nline.key',
      'env.txt', 'notes.md', 'a.env', '.environment', 'keyboard.png', 'monkey.txt', 'pem.txt', 'key', 'x.keys', 'x.pem.txt', '', 'a.PNG', 'dir.pem/readme.md'];
    // F3: every new kind in four spellings, and the names that must stay attachable
    for (const kind of NEW_KINDS) names.push(kind, kind.toUpperCase(), mixedCase(kind), `/x/y/${kind.toUpperCase()}`, `dir\\sub\\${kind}`, `${kind} `);
    names.push('id_rsa.pub', 'id_ed25519.pub', 'ID_ECDSA.PUB', 'id_ecdsa_sk.pub', 'id_rsa_backup.txt', 'id_rsa_sk', 'my_id_rsa', 'id_', 'my.keystore.md', 'notes.envrc.txt', 'envrc', 'envrc.dev', 'my.envrc.dev', '.envrcx', '.envrc-old', 'p12.txt', 'p12', 'x.p12x', 'cert.p12.txt');
    for (const n of names) assert.equal(isSecretName(n), serverIsSecretName(n), JSON.stringify(n));
    for (const n of [undefined, null, 5, {}]) assert.equal(isSecretName(n), false);
    assert.equal(names.filter(isSecretName).length >= 12, true, 'the table has secret names in it');
    assert.equal(names.filter((n) => !isSecretName(n)).length >= 15, true, 'the table has ordinary names in it');
    assert.equal(NEW_KINDS.every((k) => isSecretName(k) && serverIsSecretName(k)), true, 'every new kind is secret on both sides');
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

describe('the file chooser: the paperclip opens the shell\'s own dialog (W2-T6)', () => {
  const CHOOSER_OPEN = ['A file chooser is already open. Finish or cancel it first.', 'warn', 4000];
  const okFile = (n, over = {}) => ({ ok: true, id: uploadId(n), name: 'notes.md', size: 2048, type: 'text', ...over });
  const badFile = (error, name = 'big.bin') => ({ ok: false, name, error });
  const done = (...files) => ({ status: 200, body: { state: 'done', files } });
  const pending = { status: 200, body: { state: 'pending' } };
  const pickCalls = (r) => r.log.calls.filter((c) => /\/attachments\/pick/.test(c.path));
  const click = async (r) => { r.els['att-btn'].fire('click'); await settle(); };
  const START = '/api/app/pane/%257/attachments/pick';

  test('(+) the button posts { room: 6 } and polls every 300 ms until done; a ready and a failed file become two chips in their final states, and nothing is uploaded', async () => {
    const r = rig();
    r.state.polls = [pending, pending, done(okFile(1), badFile('too_large'))];
    await click(r);
    const calls = pickCalls(r);
    assert.deepEqual(calls[0], { path: START, method: 'POST', json: { room: 6 } });
    assert.deepEqual(calls.slice(1).map((c) => [c.method, c.path, c.json]), Array(3).fill(['GET', `${START}/${REQ}`, undefined]));
    assert.deepEqual(r.log.sleeps, [300, 300, 300]);
    assert.equal(r.log.calls.some((c) => /\/attachments$/.test(c.path)), false, 'no upload: the server already has the files');
    const [ok, bad] = r.chips().map(view);
    assert.deepEqual([ok.s, ok.busy, ok.spin, ok.name, ok.meta, ok.icons], ['ready', undefined, false, 'notes.md', '2 KB', ['#i-text']]);
    assert.deepEqual([bad.s, bad.busy, bad.spin, bad.name, bad.meta, bad.icons], ['failed', undefined, false, 'big.bin', `Too big ${MID} max 8 MB`, ['#i-warn']]);
    assert.equal(r.tray.hidden, false);
    assert.deepEqual(r.log.announce, ['Attached notes.md, 2 KB.', `big.bin can't be attached: Too big ${MID} max 8 MB.`]);
  });

  test('(+) a picked chip is a chip like any other: it can be removed (DELETE by its id) and sent (attach-send names its id, never a path)', async () => {
    const r = rig();
    r.state.polls = [done(okFile(1), okFile(2, { name: 'shot.png', type: 'png', size: 800 }))];
    await click(r);
    assert.deepEqual(r.chips().map((li) => view(li).icons[0]), ['#i-text', '#i-image']);
    r.chips()[0].kids[3].click();
    assert.deepEqual(deletes(r).map((c) => c.path), [`/api/app/pane/%257/attachments/${uploadId(1)}`]);
    await r.att.send('hello');
    assert.deepEqual(sends(r)[0].json.ids, [uploadId(2)]);
    assert.equal(r.chips().length, 0);
  });

  test('(+) every error code of a failed file reads as the upload path reads it; the two the chooser adds read "Can\'t read"', async () => {
    const want = [
      ['too_large', `Too big ${MID} max 8 MB`], ['too-big', `Too big ${MID} max 8 MB`], ['wrong-type', 'Not supported'], ['empty', 'Empty file'], ['no-project', 'Try again'],
      ['path-unusable', "Can't store"], ['folder-unsafe', "Can't store"], ['storage-full', 'Storage full'], ['disk-full', 'Disk full'],
      ['unreadable', "Can't read"], ['invalid', "Can't read"], ['busy', 'Upload failed'], ['write-failed', 'Upload failed'], ['constructor', 'Upload failed'], ['', 'Upload failed'],
    ];
    const r = rig();
    r.state.polls = [done(...want.slice(0, 6).map(([e]) => badFile(e)))];
    await click(r);
    assert.deepEqual(r.chips().map((li) => view(li).meta), want.slice(0, 6).map(([, m]) => m));
    const r2 = rig();
    r2.state.polls = [done(...want.slice(6, 12).map(([e]) => badFile(e)))];
    await click(r2);
    assert.deepEqual(r2.chips().map((li) => view(li).meta), want.slice(6, 12).map(([, m]) => m));
    const r3 = rig();
    r3.state.polls = [done(...want.slice(12).map(([e]) => badFile(e)))];
    await click(r3);
    assert.deepEqual(r3.chips().map((li) => view(li).meta), want.slice(12).map(([, m]) => m));
  });

  test('(−) M4: a picked file the server refuses as secret-file reads "Not attached" with the fixed line; the file next to it is unaffected', async () => {
    const r = rig();
    r.state.polls = [done(badFile('secret-file', '.env.dev'), { ok: true, name: 'notes.md', id: uploadId(1), size: 10, type: 'text' })];
    await click(r);
    assert.deepEqual(r.chips().map((li) => [view(li).name, view(li).s, view(li).meta]), [['.env.dev', 'failed', 'Not attached'], ['notes.md', 'ready', formatSize(10)]]);
    assert.deepEqual(r.log.problem.map((x) => x[0]), ["nika doesn't attach .env, key or certificate files."]);
  });

  test('(+) the problem lines of the upload path show for a picked file too (wrong type names the file; storage full says why), and never the server\'s own text', async () => {
    const r = rig();
    r.state.polls = [done({ ...badFile('wrong-type', 'tool.bin'), message: 'SERVER SAID THIS /secret/path' }, badFile('storage-full', 'b.md'), badFile('unreadable', 'link.txt'))];
    await click(r);
    assert.deepEqual(r.log.problem.map((x) => x[0]), [
      'tool.bin: use PNG, JPEG, GIF, WebP, PDF or UTF-8 text.',
      "nika's attachment storage is full (256 MB). Older attachments go after a day or two; try again later.",
      "link.txt: nika can't read this file (a link, a folder, or a file with another owner).",
    ]);
    assert.doesNotMatch(JSON.stringify([r.log.problem, r.log.announce, r.chips().map((li) => [view(li).name, view(li).meta])]), /SERVER|secret/);
  });

  test('(+) the room is 6 minus the chips in the tray (failed ones count)', async () => {
    const r = rig();
    await r.add(file('a.png'), file('b.png'), file('huge.bin', MAX_BYTES + 1));
    r.state.polls = [{ status: 200, body: { state: 'cancelled' } }];
    await click(r);
    assert.deepEqual(pickCalls(r)[0].json, { room: 3 });
  });

  test('(−) a full tray (room 0) never posts: the "Up to 6" line shows instead', async () => {
    const r = rig();
    await r.add(...['a', 'b', 'c', 'd', 'e', 'f'].map((n) => file(`${n}.png`)));
    assert.equal(r.chips().length, 6);
    await click(r);
    assert.deepEqual(pickCalls(r), []);
    assert.deepEqual(r.log.problem.at(-1), ['Up to 6 attachments per message.', 'warn', 4000]);
    assert.equal(r.els['att-btn'].disabled, false, 'the button was never locked');
  });

  test('(+) cancelled does nothing: no chip, no line, no announcement, and the button is back', async () => {
    const r = rig();
    r.state.polls = [pending, { status: 200, body: { state: 'cancelled' } }];
    await click(r);
    assert.equal(r.chips().length, 0);
    assert.equal(r.tray.hidden, true);
    assert.deepEqual([r.log.problem, r.log.announce, r.log.say], [[], [], []]);
    assert.deepEqual([r.els['att-btn'].disabled, r.els['att-btn'].attrs['aria-busy']], [false, undefined]);
  });

  test('(+) a done answer with no file at all adds nothing and says nothing', async () => {
    const r = rig();
    r.state.polls = [done()];
    await click(r);
    assert.deepEqual([r.chips().length, r.log.problem], [0, []]);
  });

  test('(−) 429 on the start shows the warn line for 4 s, polls nothing and gives the button back', async () => {
    const r = rig();
    r.state.pickStart = { status: 429, body: { error: 'busy', message: 'a file chooser is already open' } };
    await click(r);
    assert.deepEqual(r.log.problem, [CHOOSER_OPEN]);
    assert.equal(pickCalls(r).length, 1);
    assert.deepEqual([r.els['att-btn'].disabled, r.els['att-btn'].attrs['aria-busy']], [false, undefined]);
  });

  test('(+) while the chooser is open the button is disabled with aria-busy and no other pick starts; afterwards it is back and focused', async () => {
    let release;
    const r = rig();
    r.state.gate = new Promise((resolve) => { release = resolve; });
    r.state.polls = [done(okFile(1))];
    await click(r);
    assert.deepEqual([r.els['att-btn'].disabled, r.els['att-btn'].attrs['aria-busy']], [true, 'true']);
    r.els['att-btn'].fire('click'); // fire() ignores `disabled`, as a stray click event would
    r.els['att-btn'].fire('click');
    await settle();
    assert.equal(pickCalls(r).filter((c) => c.method === 'POST').length, 1, 'one start only');
    r.att.enable(true); // the input coming back on does not unlock the button mid-pick
    assert.equal(r.els['att-btn'].disabled, true);
    release();
    await settle();
    assert.deepEqual([r.els['att-btn'].disabled, r.els['att-btn'].attrs['aria-busy']], [false, undefined]);
    assert.equal(r.chips().length, 1);
    assert.equal(focus.el, r.els['att-btn'], 'focus returns to the button the dialog was opened from');
    await click(r);
    assert.equal(pickCalls(r).filter((c) => c.method === 'POST').length, 2, 'the next pick starts normally');
  });

  test('(−) the start fails: 404 is the gone session, 409 no-project and the rest are said in fixed words; nothing is polled; the button is back each time', async () => {
    const cases = [
      [{ status: 404, body: { error: 'not_found' } }, 'The session is gone.', 1],
      [{ status: 409, body: { error: 'no-project', message: 'SERVER TEXT' } }, "nika can't tell this session's project yet. Try again in a moment.", 0],
      [{ status: 400, body: { error: 'invalid' } }, "nika couldn't open the file chooser. Nothing was added.", 0],
      [{ status: 500, body: { error: 'internal' } }, "nika couldn't open the file chooser. Nothing was added.", 0],
      [{ status: 0, body: null }, "nika couldn't open the file chooser. Nothing was added.", 0],
      [{ status: 202, body: { reqId: '../../etc' } }, "nika couldn't open the file chooser. Nothing was added.", 0],
      [{ status: 202, body: null }, "nika couldn't open the file chooser. Nothing was added.", 0],
    ];
    for (const [reply, line, gone] of cases) {
      const r = rig();
      r.state.pickStart = reply;
      await click(r);
      assert.equal(r.log.problem.at(-1)[0], line, JSON.stringify(reply));
      assert.equal(r.log.gone, gone, JSON.stringify(reply));
      assert.equal(pickCalls(r).length, 1);
      assert.doesNotMatch(JSON.stringify(r.log.problem), /SERVER/);
      assert.equal(r.els['att-btn'].disabled, false);
    }
  });

  test('(−) a poll that fails stops the wait with a fixed line: 404 (the request is gone), any other status, a lost answer or a state the page does not know', async () => {
    const cases = [
      [{ status: 404, body: { error: 'not_found' } }, 'The file chooser closed. Nothing was added.'],
      [{ status: 500, body: { error: 'internal' } }, "nika couldn't open the file chooser. Nothing was added."],
      [{ status: 0, body: null }, "nika couldn't open the file chooser. Nothing was added."],
      [{ status: 200, body: { state: 'exploded' } }, "nika couldn't open the file chooser. Nothing was added."],
      [{ status: 200, body: null }, "nika couldn't open the file chooser. Nothing was added."],
      [{ status: 200, body: { state: 'done', files: 'nope' } }, "nika couldn't open the file chooser. Nothing was added."],
    ];
    for (const [reply, line] of cases) {
      const r = rig();
      r.state.polls = [pending, reply];
      await click(r);
      assert.equal(r.log.problem.at(-1)[0], line, JSON.stringify(reply));
      assert.deepEqual(r.log.sleeps, [300, 300]);
      assert.equal(r.chips().length, 0);
      assert.equal(r.els['att-btn'].disabled, false, 'the button is back');
    }
  });

  test('(−) a ready entry the page cannot trust (a bad id or type) shows as failed and keeps no id; control characters in a name never show', async () => {
    const r = rig();
    r.state.polls = [done(okFile(1, { id: '../../x' }), okFile(2, { type: 'exe' }), okFile(3, { name: `a${String.fromCharCode(0x202e)}b\u0007c.md` }), okFile(4, { name: 5 }))];
    await click(r);
    const v = r.chips().map(view);
    assert.deepEqual(v.map((x) => x.s), ['failed', 'failed', 'ready', 'ready']);
    assert.deepEqual(v.slice(0, 2).map((x) => x.meta), ['Upload failed', 'Upload failed']);
    assert.deepEqual(v.slice(2).map((x) => x.name), ['abc.md', 'file']);
    assert.deepEqual(r.log.calls.filter((c) => c.method === 'DELETE'), [], 'nothing is deleted: the page never held a trusted id for those');
  });

  test('(−) more files than room came back (the tray changed meanwhile): the first ones that fit become chips, the others are deleted by id, and the 6-line shows', async () => {
    const r = rig();
    await r.add(...['a', 'b', 'c', 'd'].map((n) => file(`${n}.png`)));
    r.state.polls = [done(okFile(11), okFile(12), okFile(13, { name: 'third.md' }), badFile('empty'))];
    await click(r);
    assert.equal(r.chips().length, 6);
    assert.deepEqual(deletes(r).map((c) => c.path), [`/api/app/pane/%257/attachments/${uploadId(13)}`]);
    assert.equal(r.log.problem.at(-1)[0], 'Up to 6 attachments per message.');
  });

  test('(−) no pane: the button asks for nothing', async () => {
    const none = rig({ paneId: null });
    await click(none);
    assert.deepEqual(none.log.calls, []);
  });

  test('(+) paste and drop are as they were: they read the File and post it to the upload route, and never touch the chooser', async () => {
    const r = rig();
    r.els.composer.fire('paste', { clipboardData: { files: [file('p.png')] } });
    r.els['composer-box'].fire('drop', { dataTransfer: { types: ['Files'], files: [file('d.pdf')] } });
    await settle();
    assert.deepEqual(r.log.calls.map((c) => [c.method, c.path.endsWith('/attachments')]), [['POST', true], ['POST', true]]);
    assert.equal(r.chips().length, 2);
    assert.deepEqual(pickCalls(r), []);
  });
});

describe('the paperclip while the chooser is open: its own colour, icon and word (W2-T6 fix 1)', () => {
  const OFF = { busy: undefined, label: 'Add attachments', icons: ['#i-attach'], spin: 0, line: '', shown: false };
  const ON = { busy: 'true', label: `Choosing files${DOTS}`, icons: [], spin: 1, line: `Choose files in the system dialog${DOTS}`, shown: true };
  const look = (r) => {
    const b = r.els['att-btn'];
    const note = r.els['att-tray'].afterNode;
    return { busy: b.attrs['aria-busy'], label: b.attrs['aria-label'], icons: icons(b), spin: b.all((k) => k.className === 'spin').length, line: note.textContent, shown: !note.hidden };
  };
  const noteOf = (r) => r.els['att-tray'].afterNode;
  const file1 = { ok: true, id: uploadId(1), name: 'notes.md', size: 2048, type: 'text' };
  const gated = () => { // a dialog that stays open until release() is called
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    return { gate, release };
  };

  test('(+) before any pick: the paperclip, the normal name, and the line is there but hidden and empty', () => {
    const r = rig();
    assert.deepEqual(look(r), OFF);
    const note = noteOf(r);
    assert.deepEqual([note.tag, note.className, note.attrs.role], ['p', 'att-pick', 'status']);
    assert.equal(note.parent, null, 'beside the tray, not inside it');
  });

  test('(+) while a pick is open: busy flag, spinner instead of the clip, "Choosing files" as the name, and the visible line; the spinner is hidden from assistive tech', async () => {
    const { gate, release } = gated();
    const r = rig();
    r.state.gate = gate;
    r.state.polls = [{ status: 200, body: { state: 'cancelled' } }];
    r.els['att-btn'].fire('click');
    await settle();
    assert.deepEqual(look(r), ON);
    const spin = r.els['att-btn'].all((k) => k.className === 'spin')[0];
    assert.equal(spin.attrs['aria-hidden'], 'true');
    assert.equal(r.els['att-btn'].kids.length, 1, 'the spinner replaces the clip, it does not sit beside it');
    r.els['att-btn'].fire('click'); // a stray second click neither starts a second pick nor doubles the look
    await settle();
    assert.deepEqual([look(r), r.els['att-btn'].kids.length], [ON, 1]);
    release();
    await settle();
    assert.deepEqual(look(r), OFF);
  });

  test('(+) each ending turns the look off: done, cancelled, 429, a gone session, no-project, a failed start, a closed or garbled poll', async () => {
    const endings = [
      ['done', { polls: [{ status: 200, body: { state: 'done', files: [file1] } }] }],
      ['done, nothing picked', { polls: [{ status: 200, body: { state: 'done', files: [] } }] }],
      ['cancelled', { polls: [{ status: 200, body: { state: 'cancelled' } }] }],
      ['429', { start: { status: 429, body: { error: 'busy' } } }],
      ['404 on the start', { start: { status: 404, body: { error: 'not_found' } } }],
      ['409 no-project', { start: { status: 409, body: { error: 'no-project' } } }],
      ['500 on the start', { start: { status: 500, body: null } }],
      ['no answer to the start', { start: { status: 0, body: null } }],
      ['a start without a usable reqId', { start: { status: 202, body: { reqId: '../x' } } }],
      ['poll 404', { polls: [{ status: 404, body: null }] }],
      ['poll 500', { polls: [{ status: 500, body: null }] }],
      ['an unknown state', { polls: [{ status: 200, body: { state: 'exploded' } }] }],
      ['a done answer without a list', { polls: [{ status: 200, body: { state: 'done' } }] }],
    ];
    for (const [name, { start, polls }] of endings) {
      const { gate, release } = gated();
      const r = rig();
      r.state.pickStart = gate.then(() => start ?? { status: 202, body: { reqId: REQ } });
      if (polls) r.state.polls = polls;
      r.els['att-btn'].fire('click');
      await settle();
      assert.deepEqual(look(r), ON, `${name}: on while the start is out`);
      release();
      await settle();
      assert.deepEqual(look(r), OFF, `${name}: off at the end`);
      assert.equal(r.els['att-btn'].disabled, false, name);
    }
  });

  test('(+) a pending poll keeps the look on, and the end of the wait turns it off', async () => {
    const seen = [];
    const polls = [{ status: 200, body: { state: 'pending' } }, { status: 200, body: { state: 'pending' } }, { status: 200, body: { state: 'cancelled' } }];
    const r = rig({
      reply: (p, o) => {
        if (isPickStart(p, o)) return { status: 202, body: { reqId: REQ } };
        seen.push(look(r)); // what the page shows while each poll is out
        return polls.shift();
      },
    });
    r.els['att-btn'].fire('click');
    await settle();
    assert.deepEqual(seen, [ON, ON, ON]);
    assert.deepEqual(look(r), OFF);
  });

  test('(+) a pick that ends while input is off leaves the look off and the button disabled as "off" (no busy colour, no spinner, the normal name)', async () => {
    const { gate, release } = gated();
    const r = rig();
    r.state.gate = gate;
    r.state.polls = [{ status: 200, body: { state: 'done', files: [] } }];
    r.els['att-btn'].fire('click');
    await settle();
    r.att.enable(false);
    assert.deepEqual(look(r), ON, 'the dialog is still open, and the page says so');
    release();
    await settle();
    assert.deepEqual(look(r), OFF);
    assert.equal(r.els['att-btn'].disabled, true);
  });

  test('(−) the plain "input off" state keeps its own look: disabled, no busy flag, the clip, the normal name, no line', () => {
    const r = rig();
    r.att.enable(false);
    assert.equal(r.els['att-btn'].disabled, true);
    assert.deepEqual(look(r), OFF);
    r.att.enable(true);
    assert.equal(r.els['att-btn'].disabled, false);
    assert.deepEqual(look(r), OFF);
  });

  test('(−) a full tray or a locked page starts no pick, so the look never turns on', async () => {
    const full = rig();
    await full.add(...['a', 'b', 'c', 'd', 'e', 'f'].map((n) => file(`${n}.png`)));
    full.els['att-btn'].fire('click');
    await settle();
    assert.deepEqual(look(full), OFF);
    const off = rig();
    off.att.enable(false);
    off.els['att-btn'].fire('click');
    await settle();
    assert.deepEqual(look(off), OFF);
    const none = rig({ paneId: null });
    none.els['att-btn'].fire('click');
    await settle();
    assert.deepEqual(look(none), OFF);
  });

  test('(+) the words are text: set with textContent, in ASCII source (the ellipsis is an escape)', () => {
    const c = code(SRC);
    assert.match(c, /note\.textContent\s*=/);
    assert.match(c, /CHOOSING_LABEL\s*=\s*`Choosing files\$\{DOTS\}`/);
    assert.match(c, /CHOOSING_LINE\s*=\s*`Choose files in the system dialog\$\{DOTS\}`/);
  });

  test('(+) the normal name and the clip in the code are the ones session.html draws', () => {
    const c = code(SRC);
    assert.match(c, /ADD_LABEL\s*=\s*'Add attachments'/);
    assert.match(HTML, /id="att-btn"[^>]*aria-label="Add attachments"/);
    assert.match(c, /icon\('attach'\)/);
    assert.match(HTML, /id="att-btn"[^>]*><svg class="ic" aria-hidden="true"><use href="#i-attach"\/>/);
  });
});

describe('the ways in: button, paste, drop', () => {
  test('(−) a disabled input ignores the button and every way of adding; enable(true) brings them back', async () => {
    const r = rig();
    r.att.enable(false);
    assert.equal(r.els['att-btn'].disabled, true);
    r.els['att-btn'].fire('click');
    await settle();
    assert.deepEqual(r.log.calls, [], 'the button asks for no chooser while input is off');
    const e = r.els.composer.fire('paste', { clipboardData: { files: [file('a.png')] } });
    await settle();
    assert.equal(r.chips().length, 0);
    assert.equal(e.defaultPrevented, true, 'the paste is still not inserted as text');
    r.att.enable(true);
    assert.equal(r.els['att-btn'].disabled, false);
    r.els.composer.fire('paste', { clipboardData: { files: [file('a.png')] } });
    await settle();
    assert.equal(r.chips().length, 1);
    r.els['att-btn'].fire('click');
    await settle();
    assert.equal(r.log.calls.filter(isPickStartCall).length, 1, 'and the button asks again');
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

  // ---- fix round 1: the cursor tells the truth, and a refused add says so ----------------------------------------------------------------

  const LOCKED_LINE = ['Wait until the attachments have gone, then add more.', 'warn', 4000];
  const looksOn = (r) => [r.els['composer-box'].classList.contains('dropping'), r.els['att-drop'].hidden];

  /** A page whose send is out and not answered yet: adding is locked because it is sending. */
  async function sendingRig() {
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
    return { r, finish: async () => { release(); await done; } };
  }

  test('(+) a Files drag over the box with adding open shows the drop look and the copy cursor', () => {
    const r = rig();
    const box = r.els['composer-box'];
    const dt = { types: ['Files'] };
    const e = box.fire('dragover', { dataTransfer: dt });
    assert.equal(e.defaultPrevented, true);
    assert.equal(dt.dropEffect, 'copy');
    assert.deepEqual(looksOn(r), [true, false]);
  });

  test('(−) a Files drag over the mirror or anywhere outside the box gets the none cursor; a text drag and a drag inside the box are not touched', () => {
    const r = rig();
    const mirror = new TEl('pre');
    const inside = new TEl('textarea');
    r.els['composer-box'].append(inside);
    const out = { types: ['Files'] };
    assert.equal(r.doc('dragover', { target: mirror, dataTransfer: out }).defaultPrevented, true, 'still cancelled: the window never opens the file');
    assert.equal(out.dropEffect, 'none');
    const nested = { types: ['Files'] };
    r.doc('dragover', { target: inside, dataTransfer: nested });
    assert.equal(nested.dropEffect, undefined, 'a child of the box: the box handler decides');
    const text = { types: ['text/plain'] };
    r.doc('dragover', { target: mirror, dataTransfer: text });
    assert.equal(text.dropEffect, undefined);
    const dropped = { types: ['Files'] };
    r.doc('drop', { target: mirror, dataTransfer: dropped });
    assert.equal(dropped.dropEffect, undefined, 'only dragover has an effect to set');
  });

  test('(−) a Files drag over the box while it sends or while input is off gets the none cursor and no drop look', async () => {
    const { r, finish } = await sendingRig();
    const box = r.els['composer-box'];
    const dt = { types: ['Files'] };
    assert.equal(box.fire('dragenter', { dataTransfer: dt }).defaultPrevented, true, 'still cancelled: no navigation');
    box.fire('dragover', { dataTransfer: dt });
    assert.equal(dt.dropEffect, 'none');
    assert.deepEqual(looksOn(r), [false, true]);
    await finish();
    const off = rig();
    off.att.enable(false);
    const dt2 = { types: ['Files'] };
    off.els['composer-box'].fire('dragenter', { dataTransfer: dt2 });
    off.els['composer-box'].fire('dragover', { dataTransfer: dt2 });
    assert.equal(dt2.dropEffect, 'none');
    assert.deepEqual(looksOn(off), [false, true]);
  });

  test('(−) a drag that began while adding was open loses its look the moment a send starts, and gets it back after', async () => {
    let release;
    const r = rig({
      reply: (p, o) => {
        if (isSend(p, o)) return new Promise((resolve) => { release = () => resolve({ status: 200, body: { sent: 1, images: 1 } }); });
        return { status: 200, body: { id: uploadId(1), type: 'png', size: 5 } };
      },
    });
    await r.add(file('a.png'));
    r.els['composer-box'].fire('dragover', { dataTransfer: { types: ['Files'] } });
    assert.deepEqual(looksOn(r), [true, false]);
    const done = r.att.send('hi');
    await settle();
    r.els['composer-box'].fire('dragover', { dataTransfer: { types: ['Files'] } });
    assert.deepEqual(looksOn(r), [false, true]);
    release();
    await done;
    r.els['composer-box'].fire('dragover', { dataTransfer: { types: ['Files'] } });
    assert.deepEqual(looksOn(r), [true, false]);
  });

  test('(−) files pasted during a send: the paste is cancelled, a warn line shows for 4 s, no chip, no request', async () => {
    const { r, finish } = await sendingRig();
    const before = r.log.calls.length;
    const e = r.els.composer.fire('paste', { clipboardData: { files: [file('late.png')] } });
    await settle();
    assert.equal(e.defaultPrevented, true);
    assert.deepEqual(r.log.problem, [LOCKED_LINE]);
    assert.equal(r.chips().length, 1, 'only the chip that is being sent');
    assert.equal(r.log.calls.length, before, 'nothing was posted');
    await finish();
  });

  test('(−) files dropped on the box during a send: the same line, no chip, no request, no look', async () => {
    const { r, finish } = await sendingRig();
    const before = r.log.calls.length;
    const e = r.els['composer-box'].fire('drop', { dataTransfer: { types: ['Files'], files: [file('late.png')] } });
    await settle();
    assert.equal(e.defaultPrevented, true);
    assert.deepEqual(r.log.problem, [LOCKED_LINE]);
    assert.equal(r.chips().length, 1);
    assert.equal(r.log.calls.length, before);
    assert.deepEqual(looksOn(r), [false, true]);
    await finish();
  });

  test('(−) a chooser answer that arrives while locked (input turned off): the line shows, no chip, and the stored copies are deleted', async () => {
    let release;
    const r = rig();
    r.state.gate = new Promise((resolve) => { release = resolve; });
    r.state.polls = [{ status: 200, body: { state: 'done', files: [{ ok: true, id: uploadId(1), name: 'late.png', size: 9, type: 'png' }, { ok: false, name: 'bad.bin', error: 'too_large' }] } }];
    r.els['att-btn'].fire('click');
    await settle();
    r.att.enable(false); // Claude ended while the dialog was open
    release();
    await settle();
    assert.deepEqual(r.log.problem, [LOCKED_LINE]);
    assert.equal(r.chips().length, 0);
    assert.deepEqual(deletes(r).map((c) => c.path), [`/api/app/pane/%257/attachments/${uploadId(1)}`]);
    assert.equal(r.els['att-btn'].disabled, true, 'enable(false) won over the end of the pick');
    assert.equal(r.els['att-btn'].attrs['aria-busy'], undefined);
    const off = rig();
    off.att.enable(false);
    off.els.composer.fire('paste', { clipboardData: { files: [file('a.png')] } });
    assert.deepEqual(off.log.problem, [LOCKED_LINE]);
    assert.equal(off.chips().length, 0);
  });

  test('(−) the button while a send is out asks for no chooser (the send stays the only thing in flight)', async () => {
    const { r, finish } = await sendingRig();
    const before = r.log.calls.length;
    r.els['att-btn'].fire('click');
    await settle();
    assert.equal(r.log.calls.length, before);
    assert.deepEqual(r.log.problem, []);
    await finish();
  });

  test('(+) with adding open the line never shows, and a paste or drop still adds', async () => {
    const r = rig();
    r.els.composer.fire('paste', { clipboardData: { files: [file('a.png')] } });
    r.els['composer-box'].fire('drop', { dataTransfer: { types: ['Files'], files: [file('b.pdf')] } });
    await settle();
    assert.equal(r.chips().length, 2);
    assert.deepEqual(r.log.problem, []);
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

  test('(+) W13: Claude working does not stop the send: the tray asks nothing about it (its io has no `working`), and the attach-send goes out with the sig of the push', async () => {
    const r = rig();
    assert.equal('working' in r.io, false, 'the io the page hands in has no Claude-is-busy question any more');
    await r.add(file('a.png'));
    await r.att.send('look at this');
    const sends = r.log.calls.filter((c) => c.method === 'POST' && /\/attach-send$/.test(c.path));
    assert.equal(sends.length, 1);
    assert.equal(sends[0].json.base, SIG2);
    assert.equal(r.chips().length, 0, 'sent: the tray is empty');
    assert.deepEqual(r.log.clear, ['look at this']);
  });

  test('(−) W13: the old refusal is gone from the page: no `working` in attach.js, no "when Claude is waiting" line', () => {
    assert.doesNotMatch(code(SRC), /\bworking\b/);
    assert.doesNotMatch(SRC, /Attachments go when Claude is waiting|Wait for this turn to end/);
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
    assert.deepEqual(r.log.ds, [['begin'], ['send', 'look at these'], ['end'], ['submitted', 200, null]]);
    const [send] = sends(r);
    assert.equal(send.path, '/api/app/pane/%257/attach-send');
    assert.deepEqual(send.json, { ids: [uploadId(1), uploadId(2), uploadId(3)], base: SIG2 });
    assert.deepEqual(Object.keys(send.json), ['ids', 'base']);
  });

  test('(+) enter: Claude\'s box already holds the text, so only attach-send goes, with the screen\'s sig', async () => {
    const r = rig({ screen: screenOf({ state: 'text', text: 'look at these', sig: SIG2 }) });
    await r.add(file('a.png'));
    await r.att.send('look at these');
    assert.deepEqual(r.log.ds, [['begin'], ['end'], ['submitted', 200, null]], 'no push');
    assert.deepEqual(sends(r)[0].json, { ids: [uploadId(1)], base: SIG2 });
  });

  test('(+) an empty message box with ready chips sends the attachments alone', async () => {
    const r = rig();
    await r.add(file('a.png'));
    await r.att.send('');
    assert.deepEqual(r.log.ds, [['begin'], ['end'], ['submitted', 200, null]]);
    assert.deepEqual(sends(r)[0].json, { ids: [uploadId(1)], base: SIG });
  });

  test('(+) W13: the empty-over-empty case is "nothing to send" for a plain Send, but attachments are something to send: an empty Claude input (with a suggestion or Claude\'s queue) still takes them', async () => {
    for (const screen of [screenOf({ suggestion: 'run the tests in acme-api' }), screenOf({ queued: true })]) {
      const r = rig({ screen });
      await r.add(file('a.png'));
      await r.att.send('');
      assert.deepEqual(r.log.ds, [['begin'], ['end'], ['submitted', 200, null]]);
      assert.deepEqual(sends(r)[0].json, { ids: [uploadId(1)], base: SIG });
      assert.deepEqual(r.log.ds.filter(([k]) => k === 'send'), [], 'no text is pushed');
    }
  });

  test('(+) fix round 1: after an attachment send the sync learns the box is empty (submitted 200, no draft) before the page clears its box, so no step pulls the sent text back', async () => {
    for (const [text, screen] of [['look at these', undefined], ['', undefined], ['look at these', screenOf({ state: 'text', text: 'look at these', sig: SIG2 })]]) {
      const r = rig(screen ? { screen } : {});
      await r.add(file('a.png'));
      await r.att.send(text);
      assert.deepEqual(r.log.order, ['submitted', 'clearBox'], 'submitted first, then clearBox');
      assert.equal(r.log.ds.filter(([k]) => k === 'submitted').length, 1);
      assert.ok(r.log.ds.findIndex(([k]) => k === 'submitted') > r.log.ds.findIndex(([k]) => k === 'end'), 'after the sync is released');
    }
  });

  test('(−) fix round 1: no answer of 200 means the sync is not told the box is empty (refused, failed, gone chips)', async () => {
    for (const reply of [
      { status: 409, body: { error: 'screen-changed', pasted: 1 } },
      { status: 409, body: { error: 'draft-changed', pasted: 0 } },
      { status: 500, body: null },
      { status: 0, body: null },
    ]) {
      const r = rig();
      await r.add(file('a.png'));
      r.state.sentReply = reply;
      await r.att.send('look at these');
      assert.deepEqual(r.log.ds.filter(([k]) => k === 'submitted'), [], `${reply.status}: no submitted`);
      assert.deepEqual(r.log.clear, [], `${reply.status}: the box is kept`);
    }
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
      [409, { error: 'not-idle', pasted: 0 }, 'A prompt is open in Claude or Stop is running. Nothing was sent; your text and attachments are kept.'],
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

  test('(+) it reaches the server only through the io the page gives it: no route string of its own (tier separation), five routes asked of io.path', () => {
    const c = code(SRC);
    assert.doesNotMatch(c, /\/api\//, 'ui.test.js: only the app-tier modules name /api/app, and session.js builds the paths');
    for (const call of ["io.path('attachments')", "io.path('attach-send')", 'io.path(`attachments/${id}`)', "io.path('attachments/pick')", 'io.path(`attachments/pick/${reqId}`)']) assert.ok(c.includes(call), call);
    assert.equal([...c.matchAll(/io\.path\(/g)].length, 5, 'the upload, the send, the delete, and the chooser start and poll paths only');
  });

  test('(−) the page has no webview file input anywhere: attach.js and session.html hold no att-input, no type="file", no input.click()', () => {
    const c = code(SRC);
    assert.doesNotMatch(c, /att-input|type\s*[:=]\s*['"]file['"]|\.click\(\)|createElement\(\s*['"]input['"]/);
    assert.doesNotMatch(HTML, /att-input|type="file"/i);
    for (const f of fs.readdirSync(path.join(ROOT, 'public')).filter((n) => /\.(js|html)$/.test(n))) assert.doesNotMatch(read('public', f), /type="file"|type: 'file'|att-input/, f);
  });

  test('(+) every icon it draws and every id it looks up exists in session.html', () => {
    const symbols = new Set([...HTML.matchAll(/<symbol id="i-([a-z-]+)"/g)].map((m) => m[1]));
    for (const n of ['attach', 'image', 'file', 'text', 'x', 'warn']) assert.ok(symbols.has(n), n);
    const drawn = [...code(SRC).matchAll(/\bicon\('([a-z-]+)'\)/g)].map((m) => m[1]);
    assert.ok(drawn.includes('x') && drawn.includes('warn'));
    for (const n of drawn) assert.ok(symbols.has(n), n);
    const ids = new Set([...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const used = new Set([...code(SRC).matchAll(/\bel\('([a-z-]+)'\)/g)].map((m) => m[1]));
    for (const id of ['att-tray', 'att-btn', 'att-drop', 'composer-box', 'composer']) assert.ok(used.has(id), id);
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

  test('(+) the button has no file input beside it, and the drop hint stays inside the message box', () => {
    assert.equal(tag('att-input'), '');
    assert.doesNotMatch(HTML, /type="file"|accept=/);
    assert.match(HTML, /<span class="att-drop" id="att-drop" aria-hidden="true" hidden>Drop to attach<\/span>/);
    const inbox = HTML.slice(at('<div class="inbox">'), at('<div class="mode-row"'));
    assert.ok(inbox.includes('id="att-btn"') && inbox.includes('id="att-drop"') && !inbox.includes('<input'));
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

  test('(+) the paperclip\'s chooser-open state has its own rule: busy colour and edge, opacity 1, progress cursor, tokens only; the line beside the tray has one too', () => {
    const busy = /(^|[\s}])#att-btn\[aria-busy="true"\]\s*\{([^}]*)\}/.exec(rules)?.[2] ?? '';
    assert.notEqual(busy, '', 'the rule exists');
    assert.match(busy, /opacity:\s*1\s*;/);
    assert.match(busy, /cursor:\s*progress\s*;/);
    assert.match(busy, /(^|[\s;])color:\s*var\(--busy\)/);
    assert.match(busy, /border-color:\s*var\(--busy\)/);
    assert.match(busy, /background:\s*var\(--busy-soft\)/);
    assert.match(busy, /border-style:\s*dashed/, 'a shape cue as well as the colour');
    assert.doesNotMatch(busy, /not-allowed/);
    assert.doesNotMatch(busy, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    const line = /(^|[\s}])\.att-pick\s*\{([^}]*)\}/.exec(rules)?.[2] ?? '';
    assert.match(line, /color:\s*var\(--busy\)/);
    assert.match(line, /font-size:\s*var\(--fs-small\)/);
    for (const v of ['--busy', '--busy-soft']) assert.match(TOKENS, new RegExp(`${v}:`), v);
    assert.ok([...TOKENS.matchAll(/--busy:/g)].length >= 2, 'light and dark both define the busy colour');
  });

  test('(−) the dimmed "off" look is unchanged: .btn:disabled keeps opacity 0.5 and nothing in the attachment rules restyles the plain disabled paperclip', () => {
    assert.match(CSS, /\.btn:disabled,\s*\.btn\[aria-disabled="true"\]\s*\{\s*opacity:\s*0\.5;\s*\}/);
    assert.match(CSS, /\.btn\[aria-disabled="true"\],\s*\.btn\[aria-busy="true"\]\s*\{\s*cursor:\s*not-allowed;\s*\}/);
    assert.doesNotMatch(rules, /#att-btn:disabled|#att-btn\[disabled\]|#att-btn\[aria-disabled/);
    assert.equal([...rules.matchAll(/#att-btn[^{]*\{/g)].filter((m) => !/aria-busy|\.spin/.test(m[0])).length, 0, 'every #att-btn rule is the busy one (or its spinner)');
  });

  test('(+) the chooser spinner has the still look for reduced motion as well', () => {
    assert.match(CSS, /prefers-reduced-motion[^{]*\{[^@]*#att-btn \.spin,\s*\.att \.spin\s*\{[^}]*animation:\s*none/);
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
    for (const k of ['paneId', 'path:', 'call', 'appFetch', 'ds: DS', 'enqueueJob', 'say', 'announce', 'showProblem', 'clearProblem', 'showNotice', 'setGone', 'box:', 'cols:', 'clearBox', 'focusBox']) assert.ok(call.includes(k), k);
    assert.doesNotMatch(call, /working|A\.kind/, 'W13: the tray is not told whether Claude works; attachments go while it does (Claude queues them)');
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
    const f = src.slice(src.indexOf('async function sendComposer()'), src.indexOf('async function pushThenSubmit'));
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

  test('(+) the shell answers pick-files with its own native dialog on its own thread, in the one slot pick-folder uses; only files, at most six, valid UTF-8', () => {
    const lib = read('app', 'src-tauri', 'src', 'lib.rs');
    assert.match(lib, /Sup::PickFiles\(req_id\) => start_pick_files\(app, req_id\),/);
    const fn = lib.slice(lib.indexOf('fn start_pick_files('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.match(body, /thread::spawn\(/);
    assert.ok(body.indexOf('thread::spawn(') < body.indexOf('.blocking_pick_files()'), 'the blocking dialog runs inside the thread, never on the main one');
    for (const needle of ['.set_title("Attach files")', 'protocol::valid_file(p)', 'p.to_str()', 'files_reply(&req_id, picked)', 'protocol::files_line(&req_id', 'guard.answer(']) assert.ok(body.includes(needle), needle);
    assert.ok(body.indexOf('pick_guard(') < body.indexOf('thread::spawn('), 'the guard is made before the thread starts and moved into it');
    assert.equal([...lib.matchAll(/i\.pick = Some\(/g)].length, 1, 'one claim for both kinds: the slot is shared');
    assert.equal([...lib.matchAll(/claim_pick\(app, &req_id\)/g)].length, 2, 'start_pick and start_pick_files both take it');
    assert.match(body, /let Some\(\(server, busy\)\) = claim_pick\(app, &req_id\) else \{ return \};\s+if busy \{\s+let _ = server\.send\(&protocol::files_line\(&req_id, None\)\);/, 'a second request is answered at once with null');
  });

  test('(+) both dialog threads answer through a drop guard that sends the null answer and frees the one slot, and nothing else frees it', () => {
    const lib = read('app', 'src-tauri', 'src', 'lib.rs');
    for (const [name, nullLine, answer] of [['start_pick', 'protocol::folder_line(&req_id, None)', 'guard.answer(&protocol::folder_line(&req_id, picked.as_deref()))'], ['start_pick_files', 'protocol::files_line(&req_id, None)', 'guard.answer(&files_reply(&req_id, picked))']]) {
      const fn = lib.slice(lib.indexOf(`fn ${name}(`));
      const body = fn.slice(0, fn.indexOf('\n}\n'));
      assert.ok(body.includes(`pick_guard(app, server, ${nullLine})`), `${name}: the guard carries the null answer of its kind`);
      assert.ok(body.includes(answer), `${name}: the real answer goes through the guard`);
      assert.ok(body.indexOf('pick_guard(') < body.indexOf('thread::spawn('), name);
      assert.doesNotMatch(body, /\.pick = None|server\.send\(&protocol::\w+_line\(&req_id, (picked|Some)/, `${name}: no answer or release outside the guard`);
    }
    assert.equal([...lib.matchAll(/\.pick = None/g)].length, 1, 'the slot is freed in one place, the guard\'s release');
    assert.match(lib, /impl<S: FnMut\(&str\), R: FnMut\(\)> Drop for PickGuard<S, R>/);
  });

  test('(+) the shell\'s longest path is the server\'s: PICK_PATH_MAX is the same number, and the shell counts UTF-16 units as JavaScript does', () => {
    const lib = read('app', 'src-tauri', 'src', 'lib.rs');
    const rust = Number(/const PICK_PATH_MAX: usize = (\d+);/.exec(lib)?.[1]);
    const node = Number(/const PICK_PATH_MAX = (\d+);/.exec(read('src', 'appio.js'))?.[1]);
    assert.ok(rust > 0 && rust === node, `${rust} vs ${node}`);
    assert.match(lib, /p\.encode_utf16\(\)\.count\(\) <= PICK_PATH_MAX/);
  });

  test('(−) the shell registers no drag-drop listener and keeps its navigation guard and its new-window denial', () => {
    const lib = read('app', 'src-tauri', 'src', 'lib.rs');
    assert.doesNotMatch(lib, /on_drag_drop|DragDropEvent|WindowEvent::DragDrop/);
    assert.match(lib, /\.on_navigation\(/);
    assert.match(lib, /NewWindowResponse::Deny/);
  });
});
