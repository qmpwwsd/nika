// public/ctx.js: the pure parts of the context and auto-compact UI (0.4, design sections 5 and 6). O4 adds fmtTokens and compactPreview;
// O5 adds ctxView to this file. Pure functions, run in Node.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fmtTokens, compactPreview, ctxView } from '../public/ctx.js';
import { compactLaunch } from '../src/compact.js';

const ON = (pct, window) => ({ enabled: true, pct, window });
const OFF_LINE = "Off. Sessions nika starts keep Claude Code's own setting.";

describe('fmtTokens', () => {
  test('(+) under 1000 as is, then one decimal under 10k, then whole thousands, then millions; always rounded down', () => {
    const rows = [[0, '0'], [7, '7'], [999, '999'], [1000, '1k'], [8000, '8k'], [8500, '8.5k'], [9999, '9.9k'], [10000, '10k'], [124000, '124k'], [124999, '124k'],
      [167000, '167k'], [367000, '367k'], [999999, '999k'], [1000000, '1M'], [1250000, '1.2M'], [1999999, '1.9M'], [2000000, '2M']];
    for (const [n, text] of rows) assert.equal(fmtTokens(n), text, String(n));
  });

  test('(−) anything that is not a finite, non-negative number gives null', () => {
    for (const bad of [-1, NaN, Infinity, -Infinity, '1000', null, undefined, {}, [1000], true]) assert.equal(fmtTokens(bad), null, String(bad));
  });
});

describe('compactPreview: the result line under the Auto-compact row', () => {
  test('(+) 200k: one number, the same on every model (the configured window is the model\'s at most)', () => {
    assert.equal(compactPreview(ON(80, 200000)), 'Compacts at about 160k tokens.');
    assert.equal(compactPreview(ON(20, 200000)), 'Compacts at about 40k tokens.');
    assert.equal(compactPreview(ON(83, 200000)), 'Compacts at about 166k tokens.');
  });

  test('(+) 200k above 83 %: the cap (W - 33000 = 167k) applies, not the typed per cent', () => {
    for (const p of [84, 90, 95]) assert.equal(compactPreview(ON(p, 200000)), 'Compacts at about 167k tokens.', String(p));
  });

  test('(+) 400k: the default reads "about 320k tokens (about 160k on 200k-window models)"', () => {
    assert.equal(compactPreview(ON(80, 400000)), 'Compacts at about 320k tokens (about 160k on 200k-window models).');
    assert.equal(compactPreview(ON(20, 400000)), 'Compacts at about 80k tokens (about 40k on 200k-window models).');
    assert.equal(compactPreview(ON(91, 400000)), 'Compacts at about 364k tokens (about 167k on 200k-window models).');
  });

  test('(+) 400k above 91 %: R3\'s cap (W - 33000 = 367k) on the 400k figure; 90 % and 95 % read as the owner expects', () => {
    assert.equal(compactPreview(ON(90, 400000)), 'Compacts at about 360k tokens (about 167k on 200k-window models).');
    assert.equal(compactPreview(ON(92, 400000)), 'Compacts at about 367k tokens (about 167k on 200k-window models).');
    assert.equal(compactPreview(ON(95, 400000)), 'Compacts at about 367k tokens (about 167k on 200k-window models).');
  });

  test('(+) 1M names the 1M-window models first', () => {
    assert.equal(compactPreview(ON(80, 1000000)), 'Compacts at about 800k tokens on 1M-window models (about 160k on 200k-window models).');
    assert.equal(compactPreview(ON(95, 1000000)), 'Compacts at about 950k tokens on 1M-window models (about 167k on 200k-window models).');
    assert.equal(compactPreview(ON(20, 1000000)), 'Compacts at about 200k tokens on 1M-window models (about 40k on 200k-window models).');
  });

  test('(+) the model\'s full window says the per cent and gives both figures', () => {
    assert.equal(compactPreview(ON(80, 'model')), "Compacts at 80 % of each model's window: about 800k tokens on 1M-window models, about 160k on 200k-window models.");
    assert.equal(compactPreview(ON(95, 'model')), "Compacts at 95 % of each model's window: about 950k tokens on 1M-window models, about 167k on 200k-window models.");
  });

  test('(+) off gives the Off line, whatever the other two values hold (kept, disabled controls)', () => {
    for (const window of [200000, 400000, 1000000, 'model']) assert.equal(compactPreview({ enabled: false, pct: 80, window }), OFF_LINE, String(window));
    assert.equal(compactPreview({ enabled: false, pct: NaN, window: 400000 }), OFF_LINE);
  });

  test('(+) the figures are the ones compactLaunch will start sessions with (one source of truth, 1k rounding aside)', () => {
    const k = (n) => fmtTokens(Math.floor(n / 1000) * 1000);
    for (let p = 20; p <= 95; p++) {
      const at200 = compactLaunch('claude-sonnet-4-6', ON(p, 'model')).compactAt;
      const at400 = compactLaunch('claude-opus-5-5', ON(p, 400000)).compactAt;
      const at1m = compactLaunch('claude-opus-5-5', ON(p, 1000000)).compactAt;
      assert.equal(compactPreview(ON(p, 400000)), `Compacts at about ${k(at400)} tokens (about ${k(at200)} on 200k-window models).`, String(p));
      assert.equal(compactPreview(ON(p, 1000000)), `Compacts at about ${k(at1m)} tokens on 1M-window models (about ${k(at200)} on 200k-window models).`, String(p));
      assert.equal(compactPreview(ON(p, 200000)), `Compacts at about ${k(at200)} tokens.`, String(p));
    }
  });

  test('(−) an invalid pct hides the line (null): blank, NaN, a fraction, 19, 96, a string, null', () => {
    for (const pct of [NaN, 80.5, 19, 96, 0, -20, 100, '80', null, undefined, Infinity, [80]]) {
      for (const window of [200000, 400000, 1000000, 'model']) assert.equal(compactPreview(ON(pct, window)), null, `${String(pct)} ${window}`);
    }
  });

  test('(−) an unknown window, a non-boolean enabled or no argument at all hides the line', () => {
    for (const window of [300000, '400000', 'auto', null, undefined, 0]) assert.equal(compactPreview(ON(80, window)), null, String(window));
    for (const arg of [undefined, null, {}, 'on', 5, [], { pct: 80, window: 400000 }, { enabled: 'true', pct: 80, window: 400000 }, { enabled: 1, pct: 80, window: 400000 }]) {
      assert.equal(compactPreview(arg), null, JSON.stringify(arg));
    }
  });
});

describe('ctxView: the context meter of a row and of the session header (design 0.4 section 6.1)', () => {
  const NB = '\u00a0'; // the no-break space between the number and "%"
  const ctx = (over = {}) => ({ tokens: 312000, window: 400000, compactAt: 320000, pct: 78, compaction: 'on', ...over });

  test('(+) unknown: no context, or no tokens (null or 0): a muted dash, no bar', () => {
    for (const c of [null, undefined, ctx({ tokens: 0 }), ctx({ tokens: null })]) {
      assert.deepEqual(ctxView(c), { lvl: 'unknown', text: '–', of: null, long: null, q: null, title: 'Context: no usage yet', sr: 'Context unknown' }, JSON.stringify(c));
    }
  });

  test('(+) nowin: tokens but no window or no per cent (no model seen yet): the token count, muted, no bar', () => {
    for (const c of [ctx({ window: null, pct: null, compactAt: null }), ctx({ pct: null }), ctx({ window: null })]) {
      assert.deepEqual(ctxView(c), {
        lvl: 'nowin', text: '312k', of: null, long: null, q: null, title: 'Context: 312k tokens; the window is not known yet', sr: 'Context 312k tokens, window unknown',
      }, JSON.stringify(c));
    }
  });

  test('(+) ok under 60 %: "41 %" with a bar of q = round(pct / 10)', () => {
    const v = ctxView(ctx({ tokens: 164000, pct: 41, compactAt: 320000 }));
    assert.equal(v.lvl, 'ok');
    assert.equal(v.text, `41${NB}%`);
    assert.equal(v.q, 4);
    assert.equal(v.of, '164k / 400k');
    assert.equal(v.long, `164k / 400k · 41${NB}%`);
  });

  test('(+) warn from 60 % up to (not including) 80 %; full from 80 %', () => {
    const lv = (pct) => ctxView(ctx({ pct })).lvl;
    assert.deepEqual([0, 59.9, 60, 63, 79.9, 80, 86, 100, 250].map(lv), ['ok', 'ok', 'warn', 'warn', 'warn', 'full', 'full', 'full', 'full']);
  });

  test('(+) the per cent is Math.round(pct); the bar steps are round(pct / 10), capped at 10, so 200 % fills it', () => {
    const rows = [[0, '0', 0], [4.9, '5', 0], [5, '5', 1], [41.4, '41', 4], [44.9, '45', 4], [78, '78', 8], [94.9, '95', 9], [95, '95', 10], [100, '100', 10], [137.4, '137', 10], [999, '999', 10]];
    for (const [pct, text, q] of rows) {
      const v = ctxView(ctx({ pct }));
      assert.equal(v.text, `${text}${NB}%`, String(pct));
      assert.equal(v.q, q, String(pct));
    }
  });

  test('(+) title and sr, auto-compact on: names both numbers and the compact point', () => {
    const v = ctxView(ctx());
    assert.equal(v.title, 'Context: 312k of 400k tokens (compacts at 320k)');
    assert.equal(v.sr, `Context 78${NB}% used, 312k of 400k tokens, compacts at 320k`);
  });

  test('(+) title and sr, auto-compact off: the model\'s window, and the setting is said', () => {
    const v = ctxView(ctx({ pct: 31, window: 1000000, compactAt: null, compaction: 'off' }));
    assert.equal(v.title, "Context: 312k of 1M tokens (the model's window; auto-compact is off)");
    assert.equal(v.sr, `Context 31${NB}% used, 312k of 1M tokens, auto-compact off`);
  });

  test('(+) title and sr, "none" (nika did not start the session, or it ended): no compact clause at all', () => {
    const v = ctxView(ctx({ compaction: 'none', compactAt: null }));
    assert.equal(v.title, 'Context: 312k of 400k tokens');
    assert.equal(v.sr, `Context 78${NB}% used, 312k of 400k tokens`);
  });

  test('(+) full adds ", nearly full" to sr, after any compact clause', () => {
    assert.equal(ctxView(ctx({ pct: 86 })).sr, `Context 86${NB}% used, 312k of 400k tokens, compacts at 320k, nearly full`);
    assert.equal(ctxView(ctx({ pct: 86, compaction: 'none', compactAt: null })).sr, `Context 86${NB}% used, 312k of 400k tokens, nearly full`);
    assert.equal(ctxView(ctx({ pct: 86, compaction: 'off', compactAt: null, window: 1000000 })).sr, `Context 86${NB}% used, 312k of 1M tokens, auto-compact off, nearly full`);
    assert.equal(/nearly full/.test(ctxView(ctx({ pct: 79 })).sr), false);
  });

  test('(+) over 100 % shows as is and fills the bar', () => {
    const v = ctxView(ctx({ tokens: 520000, pct: 130 }));
    assert.equal(v.lvl, 'full');
    assert.equal(v.text, `130${NB}%`);
    assert.equal(v.q, 10);
  });

  test('(+) a small count reads as is under 1000 and with a decimal under 10k', () => {
    assert.equal(ctxView(ctx({ tokens: 850, pct: 0.2 })).of, '850 / 400k');
    assert.equal(ctxView(ctx({ tokens: 8500, window: 200000, pct: 4.2, compactAt: 160000 })).title, 'Context: 8.5k of 200k tokens (compacts at 160k)');
  });

  test('(−) malformed context: not an object, a bad token count: unknown; a bad window or per cent: nowin; a bad compactAt on "on": no compact clause', () => {
    for (const c of ['x', 7, true, [], () => 0, ctx({ tokens: -1 }), ctx({ tokens: '312000' }), ctx({ tokens: NaN }), ctx({ tokens: Infinity })]) assert.equal(ctxView(c).lvl, 'unknown', String(c));
    for (const c of [ctx({ pct: -5 }), ctx({ pct: NaN }), ctx({ pct: Infinity }), ctx({ pct: '78' }), ctx({ window: 0 }), ctx({ window: -400000 }), ctx({ window: '400000' }), ctx({ window: NaN })]) {
      assert.equal(ctxView(c).lvl, 'nowin', JSON.stringify(c));
    }
    for (const compactAt of [null, undefined, -1, NaN, '320000']) {
      const v = ctxView(ctx({ compactAt }));
      assert.equal(v.title, 'Context: 312k of 400k tokens', String(compactAt));
      assert.equal(v.sr, `Context 78${NB}% used, 312k of 400k tokens`);
    }
  });

  test('(−) an unknown compaction word is read as "none"; a missing object property never throws', () => {
    for (const compaction of ['maybe', undefined, null, 7, {}]) {
      assert.equal(ctxView(ctx({ compaction })).title, 'Context: 312k of 400k tokens', String(compaction));
    }
    assert.doesNotThrow(() => ctxView({}));
    assert.equal(ctxView({}).lvl, 'unknown');
  });

  test('(−) the view carries text only: no markup character from a number-shaped input, and it never computes a window, a per cent or a threshold', () => {
    const v = ctxView(ctx({ pct: 50, window: 400000, tokens: 1 }));
    assert.equal(v.text, `50${NB}%`); // the server's pct, not tokens / window (= 0 %)
    assert.deepEqual(Object.keys(v).sort(), ['long', 'lvl', 'of', 'q', 'sr', 'text', 'title']);
    assert.equal(/[<>&"]/.test(Object.values(v).filter((x) => typeof x === 'string').join('')), false);
  });
});
