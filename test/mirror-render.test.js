// The pure part of public/mirror-render.js: capture → render model, cursor, input encoding. A tiny fake DOM covers
// applyMirror, so the test also proves that hostile text only ever lands in textContent and that styles go through element.style.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toRenderModel, withCursor, applyMirror, cellWidth, planSend, planPaste, chunkText, keyForEvent, LIMITS } from '../public/mirror-render.js';

const S = (over = {}) => ({ b: false, fg: null, bg: null, u: false, i: false, d: false, ...over });
const cap = (rows, cursor) => ({ cols: 80, rows, cursor: cursor ?? { x: 0, y: 0, visible: false } });
const span = (t, s) => ({ t, s: S(s) });
const row0 = (c) => toRenderModel(c)[0];

describe('toRenderModel: styles', () => {
  test('(+) basic 16 colours become classes, 0-7 and 8-15, foreground and background', () => {
    const [r] = toRenderModel(cap([[span('a', { fg: 1, bg: 4 }), span('b', { fg: 9, bg: 15 })]]));
    assert.deepEqual(r[0].classes, ['f1', 'b4']);
    assert.deepEqual(r[1].classes, ['f9', 'b15']);
    assert.deepEqual(r[0].style, {});
  });

  test('(+) bold, dim, italic and underline map to fixed classes', () => {
    const r = row0(cap([[span('x', { b: true, d: true, i: true, u: true })]]));
    assert.deepEqual(r[0].classes, ['sb', 'sd', 'si', 'su']);
    assert.deepEqual(row0(cap([[span('x')]]))[0].classes, []);
  });

  test('(+) 256 colours: the cube and the grey ramp become rgb() CSS values, 0-15 stay classes', () => {
    const r = row0(cap([[span('a', { fg: 16 }), span('b', { fg: 196, bg: 21 }), span('c', { fg: 232, bg: 255 }), span('d', { fg: 15 })]]));
    assert.equal(r[0].style.color, 'rgb(0, 0, 0)');
    assert.equal(r[1].style.color, 'rgb(255, 0, 0)');
    assert.equal(r[1].style.background, 'rgb(0, 0, 255)');
    assert.equal(r[2].style.color, 'rgb(8, 8, 8)');
    assert.equal(r[2].style.background, 'rgb(238, 238, 238)');
    assert.deepEqual(r[3].classes, ['f15']);
    assert.deepEqual(r[3].style, {});
  });

  test('(+) truecolour [r,g,b] becomes rgb() CSS values', () => {
    const r = row0(cap([[span('a', { fg: [95, 0, 0], bg: [1, 2, 3] })]]));
    assert.equal(r[0].style.color, 'rgb(95, 0, 0)');
    assert.equal(r[0].style.background, 'rgb(1, 2, 3)');
    assert.deepEqual(r[0].classes, []);
  });

  test('(+) reverse video swaps the colours; on default colours it uses the surface pair', () => {
    const plain = row0(cap([[span('a', { r: true })]]));
    assert.deepEqual(plain[0].classes, ['fdb', 'bdf']);
    const fgOnly = row0(cap([[span('a', { fg: 2, r: true })]]));
    assert.deepEqual(fgOnly[0].classes, ['fdb', 'b2']);
    const both = row0(cap([[span('a', { fg: 1, bg: [9, 8, 7], r: true })]]));
    assert.equal(both[0].style.color, 'rgb(9, 8, 7)');
    assert.deepEqual(both[0].classes, ['b1']);
    assert.deepEqual(row0(cap([[span('a', { r: false })]]))[0].classes, []);
  });

  test('(−) invalid colour values are dropped, not passed on', () => {
    const bad = [256, -1, 1.5, '7', 'red', '#fff', null, [1, 2], [1, 2, 3, 4], [1, 2, 300], [1, '2', 3], {}, NaN, Infinity, 'url(javascript:1)', '); x'];
    for (const c of bad) {
      const r = row0(cap([[span('a', { fg: c, bg: c })]]));
      assert.deepEqual(r[0].classes, [], JSON.stringify(c));
      assert.deepEqual(r[0].style, {}, JSON.stringify(c));
    }
  });

  test('(−) style flags must be exactly true, a missing or odd style object gives a plain span', () => {
    const r = row0(cap([[{ t: 'a' }, { t: 'b', s: null }, { t: 'c', s: 'bold' }, { t: 'd', s: { b: 1, u: 'yes', fg: 'x' } }]]));
    assert.deepEqual(r.map((x) => x.classes), [[], [], [], []]);
  });
});

describe('toRenderModel: hostile input', () => {
  test('(−) markup and script text stays literal text in the model', () => {
    const hostile = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><svg/onload=1>', '&lt;b&gt;', '${1+1}', 'javascript:alert(1)'];
    const r = row0(cap([hostile.map((t) => span(t))]));
    assert.deepEqual(r.map((x) => x.text), hostile);
    for (const x of r) assert.deepEqual(Object.keys(x).sort(), ['classes', 'style', 'text']);
  });

  test('(−) bidi overrides, C0 and C1 controls and escape bytes are removed from the text', () => {
    const [rlo, isolate, rlm] = [0x202e, 0x2066, 0x200f].map((c) => String.fromCodePoint(c)); // runtime, so no raw bidi in this file
    const r = row0(cap([[span(`a${rlo}b${isolate}c${rlm}d\u001b[31mred\u0007\u009b\u0000e\tf\u007f`)]]));
    assert.equal(r[0].text, 'abcd[31mredef');
  });

  test('(−) a class or style never comes from the span text or from an unknown field', () => {
    const r = row0(cap([[{ t: 'x', s: S({ fg: 1 }), class: 'evil', style: 'color:red', classes: ['evil'] }]]));
    assert.deepEqual(r[0].classes, ['f1']);
    assert.deepEqual(r[0].style, {});
  });

  test('(−) very long rows are cut: text units and span count are bounded', () => {
    const long = row0(cap([[span('x'.repeat(100000))]]));
    assert.equal(long[0].text.length, LIMITS.rowUnits);
    const many = row0(cap([Array.from({ length: 5000 }, (_, i) => span('ab', { fg: i % 16 }))]));
    assert.equal(many.length, LIMITS.spans);
    const cut = row0(cap([[span('x'.repeat(LIMITS.rowUnits - 1) + '\u{1F600}')]]));
    assert.ok(!/[\ud800-\udbff]$/.test(cut[0].text), 'no lone surrogate at the cut');
  });

  test('(−) 2000 rows are kept, more are cut; 100000 rows do not blow up', () => {
    const rows = (n) => Array.from({ length: n }, (_, i) => [span(`line ${i}`)]);
    assert.equal(toRenderModel(cap(rows(2000))).length, 2000);
    const huge = toRenderModel(cap(rows(100000)));
    assert.equal(huge.length, LIMITS.rows);
    assert.equal(huge[1999][0].text, 'line 1999');
  });

  test('(−) non-capture input gives an empty model', () => {
    for (const v of [null, undefined, {}, { rows: 'x' }, { rows: [null, 5, 'a', {}] }, 7]) {
      const m = toRenderModel(v);
      assert.ok(Array.isArray(m));
      assert.ok(m.every((r) => Array.isArray(r) && r.length === 0));
    }
    assert.deepEqual(row0(cap([[{ t: 5 }, { t: null }, { t: '' }, null]])), []);
  });
});

describe('withCursor', () => {
  const model = (rows) => toRenderModel(cap(rows));

  test('(+) the cursor cell is split out of its span and keeps bold/underline but not colours', () => {
    const rows = withCursor(model([[span('hello', { fg: 2, b: true, u: true })]]), { x: 1, y: 0, visible: true });
    assert.deepEqual(rows[0].map((s) => s.text), ['h', 'e', 'llo']);
    assert.deepEqual(rows[0][1].classes, ['tc', 'sb', 'su']);
    assert.deepEqual(rows[0][1].style, {});
    assert.deepEqual(rows[0][0].classes, ['f2', 'sb', 'su']);
    assert.deepEqual(rows[0][2].classes, ['f2', 'sb', 'su']);
  });

  test('(+) first cell, last cell and the cell after the text', () => {
    const base = model([[span('ab')]]);
    assert.deepEqual(withCursor(base, { x: 0, y: 0, visible: true })[0].map((s) => s.text), ['a', 'b']);
    assert.deepEqual(withCursor(base, { x: 0, y: 0, visible: true })[0][0].classes, ['tc']);
    assert.deepEqual(withCursor(base, { x: 1, y: 0, visible: true })[0].map((s) => s.classes), [[], ['tc']]);
    const after = withCursor(base, { x: 2, y: 0, visible: true })[0];
    assert.deepEqual(after.map((s) => s.text), ['ab', ' ']);
    assert.deepEqual(after[1].classes, ['tc']);
    const far = withCursor(base, { x: 5, y: 0, visible: true })[0];
    assert.deepEqual(far.map((s) => s.text), ['ab', '   ', ' ']);
  });

  test('(+) the cursor spans across span boundaries and counts wide characters as two cells', () => {
    const base = model([[span('ab', { fg: 1 }), span('cd', { fg: 2 })]]);
    const r = withCursor(base, { x: 2, y: 0, visible: true })[0];
    assert.deepEqual(r.map((s) => s.text), ['ab', 'c', 'd']);
    assert.deepEqual(r[1].classes, ['tc']);
    const wide = model([[span('日本語x')]]);
    assert.deepEqual(withCursor(wide, { x: 2, y: 0, visible: true })[0].map((s) => s.text), ['日', '本', '語x']);
    assert.deepEqual(withCursor(wide, { x: 3, y: 0, visible: true })[0].map((s) => s.text), ['日', '本', '語x'], 'second cell of a wide char');
    assert.deepEqual(withCursor(wide, { x: 6, y: 0, visible: true })[0].map((s) => s.text), ['日本語', 'x']);
    const emoji = model([[span('a😀b')]]);
    assert.deepEqual(withCursor(emoji, { x: 3, y: 0, visible: true })[0].map((s) => s.text), ['a😀', 'b']);
    assert.deepEqual(withCursor(emoji, { x: 3, y: 0, visible: true })[0][1].classes, ['tc']);
  });

  test('(+) a cursor row past the model is padded; other rows are shared, not copied', () => {
    const base = model([[span('a')], [span('b')]]);
    const out = withCursor(base, { x: 0, y: 3, visible: true });
    assert.equal(out.length, 4);
    assert.strictEqual(out[0], base[0]);
    assert.deepEqual(out[3].map((s) => s.classes), [['tc']]);
  });

  test('(−) hidden, malformed or out-of-range cursors change nothing', () => {
    const base = model([[span('abc')]]);
    for (const c of [null, undefined, {}, { x: 0, y: 0, visible: false }, { x: 0, y: 0 }, { x: -1, y: 0, visible: true }, { x: 0, y: -1, visible: true },
      { x: 1.5, y: 0, visible: true }, { x: '1', y: 0, visible: true }, { x: 0, y: 1e9, visible: true }, { x: 1e9, y: 0, visible: true }, { x: NaN, y: 0, visible: true }]) {
      assert.strictEqual(withCursor(base, c), base, JSON.stringify(c));
    }
  });

  test('(+) cellWidth: ascii 1, combining 0, CJK and emoji 2', () => {
    assert.deepEqual([cellWidth(0x61), cellWidth(0x301), cellWidth(0x65e5), cellWidth(0x1f600), cellWidth(0xff21), cellWidth(0xe9)], [1, 0, 2, 2, 2, 1]);
  });
});

// ---- applyMirror with a fake DOM ----------------------------------------------------------------------------------

function fakeDoc() {
  class Node_ {
    constructor(tag) {
      this.tag = tag; this.children = []; this.parent = null; this.className = ''; this._text = ''; this.style = {}; this.ownerDocument = doc; this.sets = [];
    }

    set textContent(v) { this._text = String(v); this.children = []; this.sets.push(String(v)); }

    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }

    appendChild(c) { c.parent = this; this.children.push(c); return c; }

    removeChild(c) { this.children = this.children.filter((x) => x !== c); }
  }
  const doc = {
    createElement: (tag) => new Node_(tag),
    createTextNode: (t) => { const n = new Node_('#text'); n._text = String(t); return n; },
  };
  return doc;
}

describe('applyMirror', () => {
  test('(+) draws one div per row, plain text as text nodes, styled runs as spans with class and element.style', () => {
    const doc = fakeDoc();
    const c = doc.createElement('div');
    const model = toRenderModel(cap([[span('plain '), span('red', { fg: 1, b: true }), span('truecolor', { fg: [1, 2, 3] })], []]));
    assert.equal(applyMirror(c, model, null), 2);
    assert.equal(c.children.length, 2);
    assert.equal(c.children[0].className, 'tl');
    const [a, b, d] = c.children[0].children;
    assert.equal(a.tag, '#text');
    assert.equal(b.tag, 'span');
    assert.equal(b.className, 'f1 sb');
    assert.equal(d.style.color, 'rgb(1, 2, 3)');
    assert.equal(c.children[0].textContent, 'plain redtruecolor');
    assert.equal(c.children[1].children.length, 0);
  });

  test('(+) the cursor is drawn, and a second apply touches only rows that changed', () => {
    const doc = fakeDoc();
    const c = doc.createElement('div');
    const rows = (a, b) => toRenderModel(cap([[span(a)], [span(b)], [span('same')]]));
    assert.equal(applyMirror(c, rows('one', 'two'), { x: 0, y: 0, visible: true }), 3);
    assert.equal(c.children[0].children[0].className, 'tc');
    const kept = c.children.slice();
    assert.equal(applyMirror(c, rows('one', 'TWO'), { x: 0, y: 0, visible: true }), 1);
    assert.deepEqual(c.children.map((x, i) => x === kept[i]), [true, true, true], 'row elements are reused');
    assert.equal(c.children[1].textContent, 'TWO');
    assert.equal(applyMirror(c, rows('one', 'TWO'), { x: 1, y: 0, visible: true }), 1, 'moving the cursor redraws only its rows');
    assert.equal(applyMirror(c, rows('one', 'TWO').slice(0, 1), null), 3, 'shrinking removes rows and redraws the cursor row');
    assert.equal(c.children.length, 1);
  });

  test('(−) hostile text lands only in textContent: no markup is parsed, no extra elements appear', () => {
    const doc = fakeDoc();
    const c = doc.createElement('div');
    const model = toRenderModel(cap([[span('<img src=x onerror=alert(1)>', { fg: 1 }), span('</div><script>x()</script>')]]));
    applyMirror(c, model, null);
    const row = c.children[0];
    assert.equal(row.children.length, 2);
    assert.equal(row.textContent, '<img src=x onerror=alert(1)></div><script>x()</script>');
    assert.ok(row.children.every((n) => n.tag === 'span' || n.tag === '#text'));
  });

  test('(−) 2000 rows with long hostile text draw without error and keep one element per row', () => {
    const doc = fakeDoc();
    const c = doc.createElement('div');
    const model = toRenderModel(cap(Array.from({ length: 2500 }, (_, i) => [span(`<b>${i}</b>`.repeat(50), { fg: i % 256 })])));
    applyMirror(c, model, { x: 3, y: 1999, visible: true });
    assert.equal(c.children.length, 2000);
  });
});

// ---- input encoding ---------------------------------------------------------------------------------------------

describe('planSend', () => {
  test('(+) empty or blank composer sends just Enter', () => {
    for (const v of ['', '   ', '\n', null, undefined]) assert.deepEqual(planSend(v).payload, { keys: ['Enter'] });
  });

  test('(+) one plain line goes as text + Enter; trailing newlines are dropped', () => {
    assert.deepEqual(planSend('hello world').payload, { text: 'hello world', keys: ['Enter'] });
    assert.deepEqual(planSend('hello\n\n').payload, { text: 'hello', keys: ['Enter'] });
    assert.deepEqual(planSend('x'.repeat(1024)).payload.text.length, 1024);
    assert.match(planSend('abc').summary, /3 characters/);
  });

  test('(+) several lines, a line over 1024 chars or a line with a tab go as a paste + Enter', () => {
    assert.deepEqual(planSend('a\nb\r\nc').payload, { paste: 'a\nb\nc', keys: ['Enter'] });
    assert.equal(planSend('x'.repeat(1025)).payload.paste.length, 1025);
    assert.deepEqual(planSend('a\tb').payload, { paste: 'a\tb', keys: ['Enter'] });
    assert.match(planSend('a\nb').summary, /2 lines/);
  });

  test('(+) a paste of exactly 16 KB passes, counted in UTF-8 bytes', () => {
    assert.equal(planSend('y'.repeat(16 * 1024)).ok, true);
    assert.equal(planSend('é'.repeat(8 * 1024)).ok, true);
  });

  test('(−) a paste over 16 KB is refused with a message, nothing to send', () => {
    for (const v of ['y'.repeat(16 * 1024 + 1), 'é'.repeat(8 * 1024 + 1), `${'line\n'.repeat(4000)}`]) {
      const p = planSend(v);
      assert.equal(p.ok, false);
      assert.equal(p.payload, undefined);
      assert.match(p.message, /16 KB/);
    }
  });

  test('(−) text and paste are never both set', () => {
    for (const v of ['a', 'a\nb', 'x'.repeat(2000)]) {
      const p = planSend(v).payload;
      assert.ok(!('text' in p && 'paste' in p));
    }
  });
});

describe('planPaste and chunkText', () => {
  test('(+) passthrough paste: short line as text, multi-line as paste, never an Enter key', () => {
    assert.deepEqual(planPaste('hi').payload, { text: 'hi' });
    assert.deepEqual(planPaste('a\r\nb').payload, { paste: 'a\nb' });
    assert.equal(planPaste(''), null);
  });

  test('(−) passthrough paste over 16 KB is refused', () => {
    assert.equal(planPaste('z'.repeat(16 * 1024 + 1)).ok, false);
  });

  test('(+) chunkText keeps pieces within the limit and never cuts a surrogate pair', () => {
    assert.deepEqual(chunkText('abcdef', 4), ['abcd', 'ef']);
    const parts = chunkText('😀'.repeat(10), 5);
    assert.ok(parts.every((p) => p.length <= 5 && p.length % 2 === 0));
    assert.equal(parts.join(''), '😀'.repeat(10));
    assert.deepEqual(chunkText(''), []);
  });
});

describe('keyForEvent (passthrough)', () => {
  const ev = (key, over = {}) => ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, isComposing: false, ...over });

  test('(+) named keys map to the allow-list names', () => {
    const map = { Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'BSpace', Delete: 'DC', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PPage', PageDown: 'NPage' };
    for (const [k, name] of Object.entries(map)) assert.deepEqual(keyForEvent(ev(k)), { kind: 'key', name }, k);
    assert.deepEqual(keyForEvent(ev('Tab', { shiftKey: true })), { kind: 'key', name: 'BTab' });
    assert.deepEqual(keyForEvent(ev('Enter', { shiftKey: true })), { kind: 'key', name: 'Enter' });
  });

  test('(+) Ctrl+letter on the allow-list maps to C-x, case-insensitively', () => {
    for (const l of 'cukaelrw') assert.deepEqual(keyForEvent(ev(l, { ctrlKey: true })), { kind: 'key', name: `C-${l}` });
    assert.deepEqual(keyForEvent(ev('C', { ctrlKey: true, shiftKey: true })), { kind: 'key', name: 'C-c' });
  });

  test('(+) printable characters, including non-ASCII and emoji, are text', () => {
    for (const k of ['a', 'Z', ' ', '/', 'é', '日', '😀']) assert.deepEqual(keyForEvent(ev(k)), { kind: 'text', text: k });
  });

  test('(+) Ctrl+] leaves passthrough', () => {
    assert.deepEqual(keyForEvent(ev(']', { ctrlKey: true })), { kind: 'leave' });
  });

  test('(−) keys off the allow-list are skipped with a reason, never sent', () => {
    for (const e of [ev('x', { altKey: true }), ev('x', { ctrlKey: true }), ev('F5'), ev('Insert'), ev('Enter', { ctrlKey: true }), ev('CapsLock'), ev('Shift')]) {
      const r = keyForEvent(e);
      assert.equal(r.kind, 'skip', JSON.stringify(e));
      assert.match(r.reason, /Not sent: .* is not on the allow-list/);
    }
  });

  test('(−) meta shortcuts and IME composition are ignored so the app and the OS keep them', () => {
    assert.deepEqual(keyForEvent(ev('v', { metaKey: true })), { kind: 'ignore' });
    assert.deepEqual(keyForEvent(ev('a', { isComposing: true })), { kind: 'ignore' });
    assert.deepEqual(keyForEvent(ev('Process')), { kind: 'ignore' });
  });
});
