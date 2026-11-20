// 0.5.1 item C (design DES-A sections 1.5, 2.1, 2.6, 2.7 and 7.3): public/image-viewer.js, the in-page viewer for screenshots.
// The real code runs against the small fake DOM (test/fake-dom.js); the browser itself is exercised by hand (LC22). The copy strings are
// written out here on purpose: the tests must not read them back from the code under test. Images are synthetic (magic bytes plus zeros).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { El, focus, installDom } from './fake-dom.js';
import { IMAGE_MIME, B64_MAX, MAX_THUMBS, MAX_THUMB_BYTES, dataUrlOf, sizeLabel, imageLine, createImageViewer } from '../public/image-viewer.js';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'image-viewer.js'), 'utf8');

// ---- synthetic images -------------------------------------------------------------------------------------------------------------------------
const b64 = (magic, n = 16) => Buffer.concat([Buffer.from(magic), Buffer.alloc(n)]).toString('base64');
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = b64([0xff, 0xd8, 0xff, 0xe0]);
const GIF = b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = b64([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const PNG_URL = `data:image/png;base64,${PNG}`;

// ---- the fake page: the markup contract of 2.7, with the ids the viewer uses ---------------------------------------------------------------------
function makePage() {
  const els = {};
  const mk = (id, tag) => { const e = new El(tag); e.attrs.id = id; els[id] = e; return e; };
  const dlg = mk('img-dlg', 'dialog');
  const h2 = mk('img-h', 'h2');
  const meta = mk('img-meta', 'span');
  const x = mk('img-x', 'button');
  const stage = mk('img-stage', 'div');
  const full = mk('img-full', 'img');
  full.hidden = true;
  const state = mk('img-state', 'p');
  const warn = new El('svg');
  const stateT = mk('img-state-t', 'span');
  const retry = mk('img-retry', 'button');
  retry.hidden = true;
  const close = mk('img-close', 'button');
  state.append(warn, stateT, retry);
  stage.append(full, state);
  dlg.append(h2, meta, x, stage, close);
  els.composer = new El('textarea');
  dlg.shows = 0;
  const show = dlg.showModal.bind(dlg);
  dlg.showModal = () => { dlg.shows += 1; show(); };
  return { els, dlg, h2, meta, x, stage, full, state, warn, stateT, retry, close };
}
const flush = () => new Promise((r) => setImmediate(r));
const answer = (status, body) => () => Promise.resolve({ status, body });
const opener = (connected = true) => { const b = new El('button'); b.isConnected = connected; return b; };
/** The status line with nothing to say (RV M5): still rendered and never hidden; only its text is empty, and the icon and Retry are off. */
const quiet = (why = '') => {
  assert.equal(P.state.hidden, false, `${why} status line not hidden`);
  assert.equal(P.stateT.textContent, '', `${why} status text empty`);
  assert.equal(P.warn.hidden, true, `${why} no icon`);
  assert.equal(P.retry.hidden, true, `${why} no Retry`);
};

let restore;
let P;
let V;
beforeEach(() => {
  P = makePage();
  restore = installDom({ getElementById: (id) => P.els[id] ?? null });
  focus.el = null;
  V = createImageViewer({ dialog: P.dlg });
});
afterEach(() => restore());

describe('constants', () => {
  test('(+) the mime table has the four types and is frozen; the limits are the design\'s', () => {
    assert.deepEqual({ ...IMAGE_MIME }, { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' });
    assert.ok(Object.isFrozen(IMAGE_MIME));
    assert.equal(B64_MAX, 11184812);
    assert.equal(MAX_THUMBS, 24);
  });

  test('(+) 0.5.4 SF (RV051 M1): the thumbnails also have a byte budget of 32 MiB, which holds at least four of the largest image nika shows (8 MiB)', () => {
    assert.equal(MAX_THUMB_BYTES, 32 * 1024 * 1024);
    assert.ok(Number.isSafeInteger(MAX_THUMB_BYTES) && MAX_THUMB_BYTES >= 8 * 1024 * 1024, 'one image of the largest size always fits an empty window');
  });

  test('(−) the file is ASCII, builds no markup, sets no inline style and runs no code from text', () => {
    assert.doesNotMatch(SRC, /[^\x00-\x7f]/);
    assert.doesNotMatch(SRC, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|\.style\b|setAttribute\(\s*['"]style/);
    assert.match(SRC, /textContent/);
  });
});

describe('dataUrlOf: a server answer becomes a data URL only when every part checks out', () => {
  test('(+) each of the four types gives data:<mime>;base64,<data>', () => {
    assert.equal(dataUrlOf({ type: 'png', data: PNG }), `data:image/png;base64,${PNG}`);
    assert.equal(dataUrlOf({ type: 'jpeg', data: JPEG }), `data:image/jpeg;base64,${JPEG}`);
    assert.equal(dataUrlOf({ type: 'gif', data: GIF }), `data:image/gif;base64,${GIF}`);
    assert.equal(dataUrlOf({ type: 'webp', data: WEBP }), `data:image/webp;base64,${WEBP}`);
  });

  test('(+) the shortest data, both paddings, and the longest allowed', () => {
    assert.equal(dataUrlOf({ type: 'png', data: 'AAAA' }), 'data:image/png;base64,AAAA');
    assert.equal(dataUrlOf({ type: 'png', data: 'AAA=' }), 'data:image/png;base64,AAA=');
    assert.equal(dataUrlOf({ type: 'png', data: 'AA==' }), 'data:image/png;base64,AA==');
    assert.equal(dataUrlOf({ type: 'png', data: 'A'.repeat(B64_MAX) }), `data:image/png;base64,${'A'.repeat(B64_MAX)}`);
  });

  test('(−) svg, other types, a missing type, a mime instead of a key, and names that exist on every object', () => {
    for (const type of ['svg', 'svg+xml', 'image/png', 'PNG', 'bmp', 'tiff', '', undefined, null, 5, {}, [], 'constructor', 'toString', '__proto__', 'hasOwnProperty', 'png"onload="x', 'png ', ' png']) {
      assert.equal(dataUrlOf({ type, data: PNG }), null, String(type));
    }
  });

  test('(−) data that is missing, not text, empty, or not base64: markup, spaces, newlines, url-safe letters, misplaced padding', () => {
    for (const data of [undefined, null, 5, {}, [], '', 'abc<', '<svg onload=x>', 'AA AA', 'AAAA\n', 'AAA\n', '\nAAAA', 'AA-A', 'AA_A', 'A===', 'AA=A', '=AAA', '====', 'data:image/png;base64,AAAA', 'AAAé', 'AAAA"', "AAAA'", 'AAAA;']) {
      assert.equal(dataUrlOf({ type: 'png', data }), null, JSON.stringify(data));
    }
    assert.equal(dataUrlOf({ type: 'png' }), null);
  });

  test('(−) a length that is not a multiple of four, and one past B64_MAX', () => {
    for (const n of [1, 2, 3, 5, 6, 7, 4097 + 2]) assert.equal(dataUrlOf({ type: 'png', data: 'A'.repeat(n) }), null, `length ${n}`);
    assert.equal(dataUrlOf({ type: 'png', data: 'A'.repeat(B64_MAX + 4) }), null);
    assert.equal(dataUrlOf({ type: 'png', data: 'A'.repeat(B64_MAX + 1) }), null);
  });

  test('(−) no answer at all, or one that is not an object', () => {
    for (const body of [undefined, null, 'data:image/png;base64,AAAA', 5, true, [], [PNG]]) assert.equal(dataUrlOf(body), null, JSON.stringify(body));
  });

  test('(−) only the two fields are read: an extra "url" or "src" never leaks into the result', () => {
    assert.equal(dataUrlOf({ type: 'png', data: PNG, url: 'https://example.invalid/x.png', src: 'javascript:1' }), PNG_URL);
  });
});

describe('sizeLabel: a size in words', () => {
  test('(+) kilobytes rounded to a whole number, megabytes with one decimal (1024-based)', () => {
    assert.equal(sizeLabel(861234), '841 KB');
    assert.equal(sizeLabel(1258291), '1.2 MB');
    assert.equal(sizeLabel(1024), '1 KB');
    assert.equal(sizeLabel(40211), '39 KB');
    assert.equal(sizeLabel(8 * 1024 * 1024), '8.0 MB');
    assert.equal(sizeLabel(1048575), '1.0 MB', 'never "1024 KB"');
  });

  test('(+) under a kilobyte it counts bytes, and zero is allowed', () => {
    assert.equal(sizeLabel(0), '0 B');
    assert.equal(sizeLabel(1), '1 B');
    assert.equal(sizeLabel(1023), '1023 B');
  });

  test('(−) anything that is not a whole number of bytes from 0 up gives an empty text', () => {
    for (const n of [-1, -1024, 1.5, NaN, Infinity, -Infinity, '1024', '', null, undefined, {}, [], true, 2 ** 60]) assert.equal(sizeLabel(n), '', String(n));
  });
});

describe('imageLine: fixed copy, never the server\'s words', () => {
  test('(+) one line per status the viewer tells apart', () => {
    assert.equal(imageLine(404), 'This image is no longer available.');
    assert.equal(imageLine(413), 'This image is too large to show here (over 8 MB).');
    assert.equal(imageLine(415), 'nika shows PNG, JPEG, GIF and WebP images only.');
    assert.equal(imageLine('loading'), 'Loading image…');
    assert.equal(imageLine('decode'), 'The image data could not be shown.');
  });

  test('(+) a lost request (0), a server error, and every other status share the generic line', () => {
    for (const s of [0, 500, 502, 503, 400, 401, 403, 418, 429, 200, 204, 304, 999]) assert.equal(imageLine(s), 'The image could not be loaded.', String(s));
  });

  test('(−) text, objects, a server error body and a missing status give the generic line, never their own words', () => {
    for (const s of ['404', '413', '<script>alert(1)</script>', 'Not Found', 'too-large', 'not-image', { error: 'not_found', message: 'boom' }, [404], null, undefined, NaN, -1, 404.5, true, 'LOADING', 'Decode']) {
      assert.equal(imageLine(s), 'The image could not be loaded.', JSON.stringify(s));
    }
  });

  test('(+) every answer is one of six fixed lines', () => {
    const all = new Set([404, 413, 415, 'loading', 'decode', 0, 500, 'x', null, {}].map(imageLine));
    assert.equal(all.size, 6);
  });
});

describe('createImageViewer: open with an image already in hand', () => {
  test('(+) a modal opens with the name, the meta and the image; focus is on the close button; the loading line is gone', async () => {
    const o = opener();
    await V.open({ name: 'Image from your message', meta: 'PNG · 841 KB', src: PNG_URL, opener: o });
    assert.equal(P.dlg.open, true);
    assert.equal(P.dlg.shows, 1);
    assert.equal(V.isOpen(), true);
    assert.equal(P.h2.textContent, 'Image from your message');
    assert.equal(P.meta.textContent, 'PNG · 841 KB');
    assert.equal(P.full.attrs.alt, 'Image from your message');
    assert.equal(P.full.attrs.src, PNG_URL);
    assert.equal(P.full.hidden, false);
    quiet();
    assert.equal(focus.el, P.x);
  });

  test('(+) the natural size is added to the meta once the image has loaded', async () => {
    await V.open({ name: 'Image', meta: 'PNG · 841 KB', src: PNG_URL, opener: opener() });
    P.full.naturalWidth = 1280;
    P.full.naturalHeight = 720;
    P.full.fire('load');
    assert.equal(P.meta.textContent, 'PNG · 841 KB · 1280 × 720');
  });

  test('(+) with no meta the size stands alone', async () => {
    await V.open({ name: 'Image', src: PNG_URL, opener: opener() });
    P.full.naturalWidth = 64;
    P.full.naturalHeight = 48;
    P.full.fire('load');
    assert.equal(P.meta.textContent, '64 × 48');
  });

  test('(−) a size that is zero, negative, fractional or missing leaves the meta alone; a second load event does not add it twice', async () => {
    await V.open({ name: 'Image', meta: 'PNG', src: PNG_URL, opener: opener() });
    for (const [w, h] of [[0, 10], [10, 0], [-1, 5], [5.5, 4], [undefined, undefined], [NaN, 3]]) {
      P.full.naturalWidth = w;
      P.full.naturalHeight = h;
      P.full.fire('load');
      assert.equal(P.meta.textContent, 'PNG', `${w}x${h}`);
    }
    P.full.naturalWidth = 8;
    P.full.naturalHeight = 6;
    P.full.fire('load');
    P.full.fire('load');
    assert.equal(P.meta.textContent, 'PNG · 8 × 6');
  });

  test('(+) a name that is not text falls back to "Image", and a meta that is not text to nothing', async () => {
    await V.open({ name: 42, meta: { a: 1 }, src: PNG_URL, opener: opener() });
    assert.equal(P.h2.textContent, 'Image');
    assert.equal(P.meta.textContent, '');
    assert.equal(P.full.attrs.alt, 'Image');
  });

  test('(−) the name and meta are text: markup in them is shown as characters, never built', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    await V.open({ name: evil, meta: evil, src: PNG_URL, opener: opener() });
    assert.equal(P.h2.textContent, evil);
    assert.equal(P.meta.textContent, evil);
    assert.deepEqual(P.h2.kids, []);
    assert.equal(P.full.attrs.alt, evil);
  });

  test('(−) a src that is not an image data URL of the four types is never put on the image: the fixed "images only" line shows', async () => {
    for (const src of ['https://example.invalid/a.png', 'javascript:alert(1)', 'data:image/svg+xml;base64,AAAA', 'data:text/html;base64,AAAA', 'data:image/png;base64,<svg>', 'data:image/png,AAAA', 'data:image/png;base64,', '//x/y.png', '/api/app/session/x/image/1:0', 5, {}, '']) {
      P = makePage();
      restore();
      restore = installDom({ getElementById: (id) => P.els[id] ?? null });
      V = createImageViewer({ dialog: P.dlg });
      await V.open({ name: 'Image', src, opener: opener() });
      assert.equal(P.full.attrs.src, undefined, `src ${String(src)} not set`);
      assert.equal(P.full.hidden, true);
      assert.equal(P.stateT.textContent, 'nika shows PNG, JPEG, GIF and WebP images only.', String(src));
      assert.equal(P.retry.hidden, true, 'a retry would change nothing');
    }
  });

  test('(−) neither a src nor a load: the "no longer available" line, no Retry, nothing set', async () => {
    await V.open({ name: 'Image', opener: opener() });
    assert.equal(P.stateT.textContent, 'This image is no longer available.');
    assert.equal(P.retry.hidden, true);
    assert.equal(P.full.attrs.src, undefined);
    assert.equal(P.dlg.open, true, 'the dialog still opens, with the line');
  });
});

describe('createImageViewer: closing and focus', () => {
  test('(+) Close, the X, the backdrop and the browser\'s own close (Esc) each close it and put focus back on the opener', async () => {
    const ways = {
      'Close button': () => P.close.click(),
      'X button': () => P.x.click(),
      backdrop: () => P.dlg.fire('click', { target: P.dlg }),
      'Esc (the browser closes the dialog)': () => P.dlg.close(),
    };
    for (const [name, go] of Object.entries(ways)) {
      const o = opener();
      await V.open({ name: 'Image', src: PNG_URL, opener: o });
      assert.equal(V.isOpen(), true, name);
      go();
      assert.equal(P.dlg.open, false, name);
      assert.equal(V.isOpen(), false, name);
      assert.equal(focus.el, o, name);
    }
  });

  test('(+) closing drops the image from the page (the big data URL is released) and hides it again', async () => {
    await V.open({ name: 'Image', src: PNG_URL, opener: opener() });
    assert.equal(P.full.attrs.src, PNG_URL);
    V.close();
    assert.equal(P.full.attrs.src, undefined);
    assert.equal(P.full.hidden, true);
  });

  test('(−) a click inside the stage or on the image is not a backdrop click: the viewer stays open', async () => {
    await V.open({ name: 'Image', src: PNG_URL, opener: opener() });
    P.dlg.fire('click', { target: P.stage });
    P.dlg.fire('click', { target: P.full });
    P.dlg.fire('click', { target: P.h2 });
    assert.equal(V.isOpen(), true);
  });

  test('(−) an opener that left the page sends focus to the message box instead', async () => {
    const gone = opener(false);
    await V.open({ name: 'Image', src: PNG_URL, opener: gone });
    V.close();
    assert.equal(focus.el, P.els.composer);
  });

  test('(−) no opener at all: focus goes to the message box; with no message box either, nothing throws', async () => {
    await V.open({ name: 'Image', src: PNG_URL });
    V.close();
    assert.equal(focus.el, P.els.composer);
    delete P.els.composer;
    focus.el = null;
    await V.open({ name: 'Image', src: PNG_URL, opener: null });
    focus.el = null;
    assert.doesNotThrow(() => V.close());
    assert.equal(focus.el, null);
  });

  test('(−) closing a viewer that is not open does nothing', () => {
    assert.doesNotThrow(() => V.close());
    assert.equal(V.isOpen(), false);
    assert.equal(focus.el, null);
    assert.equal(P.dlg.shows, 0);
  });

  test('(−) opening again while open swaps the content and the opener without a second showModal; focus returns to the newer opener', async () => {
    const first = opener();
    const second = opener();
    await V.open({ name: 'First', src: PNG_URL, opener: first });
    await V.open({ name: 'Second', meta: 'GIF', src: `data:image/gif;base64,${GIF}`, opener: second });
    assert.equal(P.dlg.shows, 1);
    assert.equal(P.h2.textContent, 'Second');
    assert.equal(P.meta.textContent, 'GIF');
    V.close();
    assert.equal(focus.el, second);
  });

  test('(−) the page can reopen it after a close (state does not stick)', async () => {
    await V.open({ name: 'One', src: PNG_URL, opener: opener() });
    V.close();
    await V.open({ name: 'Two', src: PNG_URL, opener: opener() });
    assert.equal(V.isOpen(), true);
    assert.equal(P.dlg.shows, 2);
    assert.equal(P.h2.textContent, 'Two');
  });
});

describe('createImageViewer: open with a loader', () => {
  test('(+) the loading line shows first (status text, no icon, no image, no Retry); a 200 then shows the image from the data URL', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const p = V.open({ name: 'Image from Claude', meta: 'PNG', load: () => gate, opener: opener() });
    assert.equal(P.dlg.open, true);
    assert.equal(P.state.hidden, false);
    assert.equal(P.stateT.textContent, 'Loading image…');
    assert.equal(P.warn.hidden, true, 'the warning icon is hidden while loading');
    assert.equal(P.full.hidden, true);
    assert.equal(P.retry.hidden, true);
    assert.equal(focus.el, P.x);
    release({ status: 200, body: { type: 'png', data: PNG } });
    await p;
    assert.equal(P.full.attrs.src, PNG_URL);
    assert.equal(P.full.hidden, false);
    quiet();
    assert.equal(P.full.attrs.alt, 'Image from Claude');
  });

  test('(−) 404, 413 and 415 show their fixed lines with the warning icon, no image and no Retry', async () => {
    const lines = { 404: 'This image is no longer available.', 413: 'This image is too large to show here (over 8 MB).', 415: 'nika shows PNG, JPEG, GIF and WebP images only.' };
    for (const [status, line] of Object.entries(lines)) {
      P = makePage();
      restore();
      restore = installDom({ getElementById: (id) => P.els[id] ?? null });
      V = createImageViewer({ dialog: P.dlg });
      await V.open({ name: 'Image', load: answer(Number(status), { error: 'x' }), opener: opener() });
      assert.equal(P.stateT.textContent, line, status);
      assert.equal(P.state.hidden, false, status);
      assert.equal(P.warn.hidden, false, status);
      assert.equal(P.full.hidden, true, status);
      assert.equal(P.full.attrs.src, undefined, status);
      assert.equal(P.retry.hidden, true, status);
    }
  });

  test('(−) status 0, 5xx and any other status show the generic line with a Retry button', async () => {
    for (const status of [0, 500, 503, 400, 403, 429, 204]) {
      P = makePage();
      restore();
      restore = installDom({ getElementById: (id) => P.els[id] ?? null });
      V = createImageViewer({ dialog: P.dlg });
      await V.open({ name: 'Image', load: answer(status, null), opener: opener() });
      assert.equal(P.stateT.textContent, 'The image could not be loaded.', String(status));
      assert.equal(P.retry.hidden, false, String(status));
      assert.equal(P.warn.hidden, false, String(status));
    }
  });

  test('(−) Retry calls load again, shows the loading line, moves focus off the vanishing button, and a success then shows the image', async () => {
    let calls = 0;
    const load = () => { calls += 1; return Promise.resolve(calls === 1 ? { status: 0, body: null } : { status: 200, body: { type: 'jpeg', data: JPEG } }); };
    await V.open({ name: 'Image', load, opener: opener() });
    assert.equal(calls, 1);
    assert.equal(P.retry.hidden, false);
    focus.el = P.retry;
    P.retry.click();
    assert.equal(calls, 2);
    assert.equal(P.retry.hidden, true);
    assert.equal(P.stateT.textContent, 'Loading image…');
    assert.equal(focus.el, P.x, 'focus does not stay on a hidden button');
    await flush();
    assert.equal(P.full.attrs.src, `data:image/jpeg;base64,${JPEG}`);
    quiet();
  });

  test('(−) Retry that fails again shows the line and the button again', async () => {
    let calls = 0;
    await V.open({ name: 'Image', load: () => { calls += 1; return Promise.resolve({ status: 502, body: null }); }, opener: opener() });
    P.retry.click();
    await flush();
    assert.equal(calls, 2);
    assert.equal(P.retry.hidden, false);
    assert.equal(P.stateT.textContent, 'The image could not be loaded.');
  });

  test('(−) a 200 whose body is not a good image (null, svg, bad base64, wrong shape) shows the "images only" line, with no Retry', async () => {
    for (const body of [null, undefined, { type: 'svg', data: PNG }, { type: 'png', data: 'not base64!' }, { type: 'png', data: 'AAA' }, 'x', { data: PNG }]) {
      P = makePage();
      restore();
      restore = installDom({ getElementById: (id) => P.els[id] ?? null });
      V = createImageViewer({ dialog: P.dlg });
      await V.open({ name: 'Image', load: answer(200, body), opener: opener() });
      assert.equal(P.stateT.textContent, 'nika shows PNG, JPEG, GIF and WebP images only.', JSON.stringify(body));
      assert.equal(P.retry.hidden, true, JSON.stringify(body));
      assert.equal(P.full.attrs.src, undefined, JSON.stringify(body));
    }
  });

  test('(−) a load that rejects, throws at once, or answers with nothing is a lost request: generic line and Retry', async () => {
    const loaders = [() => Promise.reject(new Error('boom')), () => { throw new Error('sync boom'); }, () => Promise.resolve(undefined), () => Promise.resolve(null), () => Promise.resolve({ body: {} }), () => Promise.resolve({ status: '200', body: { type: 'png', data: PNG } })];
    for (const load of loaders) {
      P = makePage();
      restore();
      restore = installDom({ getElementById: (id) => P.els[id] ?? null });
      V = createImageViewer({ dialog: P.dlg });
      await V.open({ name: 'Image', load, opener: opener() });
      assert.equal(P.stateT.textContent, 'The image could not be loaded.');
      assert.equal(P.retry.hidden, false);
    }
  });

  test('(−) the server\'s own words never reach the page: an error body with markup is ignored, the fixed line shows', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    await V.open({ name: 'Image', load: answer(500, { error: evil, message: evil }), opener: opener() });
    assert.equal(P.stateT.textContent, 'The image could not be loaded.');
    assert.doesNotMatch(JSON.stringify(P.state, (k, v) => (k === 'parent' ? undefined : v)), /onerror/);
  });

  test('(−) an answer that comes after the viewer was closed is dropped: no image, no line, no focus change', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const o = opener();
    const p = V.open({ name: 'Image', load: () => gate, opener: o });
    V.close();
    assert.equal(focus.el, o);
    focus.el = null;
    release({ status: 200, body: { type: 'png', data: PNG } });
    await p;
    assert.equal(P.full.attrs.src, undefined);
    assert.equal(P.full.hidden, true);
    assert.equal(focus.el, null);
  });

  test('(−) an answer to an older open that comes after a newer open is dropped (the newer image wins)', async () => {
    let releaseOld;
    const old = new Promise((r) => { releaseOld = r; });
    const p1 = V.open({ name: 'Old', load: () => old, opener: opener() });
    const p2 = V.open({ name: 'New', load: answer(200, { type: 'gif', data: GIF }), opener: opener() });
    await p2;
    assert.equal(P.full.attrs.src, `data:image/gif;base64,${GIF}`);
    releaseOld({ status: 200, body: { type: 'png', data: PNG } });
    await p1;
    assert.equal(P.full.attrs.src, `data:image/gif;base64,${GIF}`, 'the old answer did not replace the new image');
    assert.equal(P.h2.textContent, 'New');
  });

  test('(−) Retry after a close does nothing (the click cannot reach a closed viewer\'s load)', async () => {
    let calls = 0;
    await V.open({ name: 'Image', load: () => { calls += 1; return Promise.resolve({ status: 0, body: null }); }, opener: opener() });
    V.close();
    P.retry.click();
    await flush();
    assert.equal(calls, 1);
  });

  test('(−) when src and load are both given, src wins and load is never called', async () => {
    let calls = 0;
    await V.open({ name: 'Image', src: PNG_URL, load: () => { calls += 1; return Promise.resolve({ status: 0 }); }, opener: opener() });
    assert.equal(calls, 0);
    assert.equal(P.full.attrs.src, PNG_URL);
  });

  test('(+) open settles after the load is over and never rejects', async () => {
    await assert.doesNotReject(V.open({ name: 'Image', load: () => Promise.reject(new Error('x')), opener: opener() }));
    await assert.doesNotReject(V.open({ name: 'Image', load: () => { throw new Error('y'); }, opener: opener() }));
  });
});

describe('createImageViewer: the picture itself failing to decode', () => {
  test('(−) the image\'s error event shows the decode line, hides the image, offers no Retry (the bytes would be the same)', async () => {
    await V.open({ name: 'Image', src: PNG_URL, opener: opener() });
    P.full.fire('error');
    assert.equal(P.stateT.textContent, 'The image data could not be shown.');
    assert.equal(P.state.hidden, false);
    assert.equal(P.warn.hidden, false);
    assert.equal(P.full.hidden, true);
    assert.equal(P.retry.hidden, true);
  });

  test('(−) an error event after the viewer was closed changes nothing (removing the src can fire one in some browsers)', async () => {
    await V.open({ name: 'Image', src: PNG_URL, opener: opener() });
    V.close();
    const before = P.stateT.textContent;
    P.full.fire('error');
    P.full.fire('load');
    assert.equal(P.stateT.textContent, before);
    quiet('after close');
  });
});

describe('createImageViewer: the markup it needs', () => {
  test('(−) a page without the markup fails at once with a clear message, naming the missing id', () => {
    for (const id of ['img-h', 'img-meta', 'img-x', 'img-full', 'img-state', 'img-state-t', 'img-retry', 'img-close']) {
      const page = makePage();
      delete page.els[id];
      restore();
      restore = installDom({ getElementById: (i) => page.els[i] ?? null });
      assert.throws(() => createImageViewer({ dialog: page.dlg }), (e) => e instanceof Error && e.message.includes(id), id);
    }
  });

  test('(−) no dialog: a clear error, not a TypeError from deep inside', () => {
    for (const dialog of [undefined, null, {}]) assert.throws(() => createImageViewer({ dialog }), /dialog/i);
    assert.throws(() => createImageViewer(), /dialog/i);
  });
});

// ---- round RV, M5: the status line stays rendered; only its text changes -------------------------------------------------------------------------
describe('createImageViewer: the status line is never hidden (RV M5)', () => {
  // role="status" is a live region. One that goes from hidden to visible together with its text may not be announced by a screen reader, so the
  // element stays rendered for the whole life of the page and only its text changes (empty when there is nothing to say).
  const watchAttrs = () => {
    const names = [];
    const set = P.state.setAttribute.bind(P.state);
    P.state.setAttribute = (n, v) => { names.push(n); return set(n, v); };
    return names;
  };

  test('(+) through a whole life (loading, each failure, Retry, success, a decode error, close, reopen) the element is never hidden and never gets the attribute', async () => {
    const names = watchAttrs();
    const seen = [];
    const look = (want) => {
      seen.push(P.state.hidden);
      if (want === '') quiet(); else assert.equal(P.stateT.textContent, want);
    };
    let release;
    const gate = new Promise((r) => { release = r; });
    const first = V.open({ name: 'Image', load: () => gate, opener: opener() });
    look('Loading image…');
    release({ status: 0, body: null });
    await first;
    look('The image could not be loaded.');
    P.retry.click(); // the second call of the same loader: the gate is spent, so it answers the same
    await flush();
    look('The image could not be loaded.');
    for (const [status, line] of [[404, 'This image is no longer available.'], [413, 'This image is too large to show here (over 8 MB).'], [415, 'nika shows PNG, JPEG, GIF and WebP images only.'], [500, 'The image could not be loaded.']]) {
      await V.open({ name: 'Image', load: answer(status, null), opener: opener() });
      look(line);
    }
    await V.open({ name: 'Image', load: answer(200, { type: 'png', data: PNG }), opener: opener() });
    look('');
    P.full.fire('error');
    look('The image data could not be shown.');
    V.close();
    look('');
    await V.open({ name: 'Image', src: PNG_URL, opener: opener() });
    look('');
    await V.open({ name: 'Image', src: 'javascript:alert(1)', opener: opener() });
    look('nika shows PNG, JPEG, GIF and WebP images only.');
    assert.ok(seen.length >= 12, `${seen.length} checkpoints`);
    assert.deepEqual(seen.filter((h) => h !== false), [], 'hidden at no checkpoint');
    assert.equal(names.includes('hidden'), false, 'the attribute was never set on the element');
  });

  test('(+) the text goes away by being emptied: a failure line is replaced by an empty text, not by hiding the line', async () => {
    await V.open({ name: 'Image', load: answer(404, null), opener: opener() });
    assert.equal(P.stateT.textContent, 'This image is no longer available.');
    await V.open({ name: 'Image', src: PNG_URL, opener: opener() });
    quiet('after a success');
    assert.equal(P.state.kids.includes(P.stateT), true, 'the text node is still in the line');
  });

  test('(−) a close while a failure with Retry shows leaves nothing behind: the text is empty and Retry is off, also when the next open shows a picture', async () => {
    await V.open({ name: 'Image', load: answer(0, null), opener: opener() });
    assert.equal(P.retry.hidden, false);
    assert.equal(P.warn.hidden, false);
    V.close();
    quiet('after the close');
    await V.open({ name: 'Image', src: PNG_URL, opener: opener() });
    quiet('reopened with a picture');
  });

  test('(−) the page\'s markup: the line carries role="status" and no hidden attribute from the start', () => {
    const html = fs.readFileSync(new URL('../public/session.html', import.meta.url), 'utf8');
    const tag = /<p\b[^>]*\bid="img-state"[^>]*>/.exec(html)?.[0] ?? '';
    assert.match(tag, /\brole="status"/);
    assert.doesNotMatch(tag, /\bhidden\b/);
  });

  test('(−) the viewer\'s code never hides the status line: it is not passed to the hide helper', () => {
    const src = fs.readFileSync(new URL('../public/image-viewer.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.doesNotMatch(src, /hide\(\s*E\.state\b/);
    assert.doesNotMatch(src, /E\.state\.(?:hidden|setAttribute)/);
  });

  test('(+) the empty line takes no row of its own: the stage lays the picture and the line in one cell (the picture does not move up)', () => {
    const css = fs.readFileSync(new URL('../public/session.css', import.meta.url), 'utf8');
    assert.match(css, /\.img-stage\s*>\s*\*\s*\{[^}]*grid-area:\s*1\s*\/\s*1/);
  });
});
