// public/ctx.js: the pure parts of the context and auto-compact UI (0.4, design sections 5 and 6). O4 adds fmtTokens and compactPreview;
// O5 adds ctxView to this file. Pure functions, run in Node.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fmtTokens, compactPreview } from '../public/ctx.js';
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
