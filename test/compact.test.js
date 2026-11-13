// Auto-compact launch env (0.4, ADR 0014): modelWindow (src/models.js) and compactLaunch / compactEnv (src/compact.js). Pure functions.
// The numbers are spike S2's: Claude Code compacts at min(floor(effective x PCT / 100), effective - 13000) with effective = window - 20000.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_CATALOG, modelWindow } from '../src/models.js';
import { compactLaunch, compactEnv, validWindow, validPct, WINDOW_ENV, PCT_ENV } from '../src/compact.js';

const ON = (pct, window) => ({ enabled: true, pct, window });
const M1 = 'claude-opus-5-5'; // a 1M-window model
const M2 = 'claude-sonnet-4-6'; // a 200k-window model

describe('modelWindow', () => {
  test('(+) 5.x ids and the measured aliases are 1M, 4.x ids are 200k', () => {
    for (const id of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5',
      'best', 'fable', 'opus', 'sonnet', 'haiku', 'opusplan', 'opus[1m]', 'sonnet[1m]']) assert.equal(modelWindow(id), 1_000_000, id);
    for (const id of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5']) assert.equal(modelWindow(id), 200_000, id);
  });

  test('(+) every catalog entry carries a window of 200k or 1M, and modelWindow returns it', () => {
    for (const m of MODEL_CATALOG) {
      assert.ok(m.window === 200_000 || m.window === 1_000_000, m.id);
      assert.equal(modelWindow(m.id), m.window, m.id);
    }
  });

  test('(+) an id outside the catalog that ends in [1m] is 1M', () => {
    for (const id of ['haiku[1m]', 'claude-opus-5-5[1m]', 'claude-haiku-4-5[1m]']) assert.equal(modelWindow(id), 1_000_000, id);
  });

  test('(+) one trailing -YYYYMMDD date suffix is dropped before the lookup: a dated 5.x catalog id is 1M, a dated 4.x id 200k', () => {
    for (const id of ['claude-sonnet-5-5-20260101', 'claude-fable-5-1-20260315', 'claude-opus-5-20260101', 'claude-haiku-5-5-20261231']) assert.equal(modelWindow(id), 1_000_000, id);
    for (const id of ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6-20260101', 'claude-opus-4-6-20260202', 'claude-sonnet-4-5-20250929']) assert.equal(modelWindow(id), 200_000, id);
  });

  test('(−) an unknown dated id is 200k, and only a trailing block of exactly 8 digits after a hyphen is dropped, once', () => {
    for (const id of ['claude-foo-9-20260101', 'claude-sonnet-5-5-2026010', 'claude-sonnet-5-5-202601011', 'claude-sonnet-5-5-20260101-20260102',
      'claude-20260101-sonnet-5-5', 'claude-sonnet-5-520260101', 'claude-sonnet-5-5-2026010a', '-20260101']) assert.equal(modelWindow(id), 200_000, id);
  });

  test('(−) unknown, custom and malformed ids are 200k, the conservative side', () => {
    for (const id of ['claude-foo-9', 'weird', '', 'opus[2m]', '[1m]x', '__proto__', 'constructor', 'toString', null, undefined, 5, {}, ['opus']]) {
      assert.equal(modelWindow(id), 200_000, String(id));
    }
  });
});

describe('compactLaunch: a dated model id', () => {
  test('(+) uses the same lookup: a dated 5.x id gets the 1M window, a dated 4.x id and an unknown dated id 200k', () => {
    const model = { enabled: true, pct: 80, window: 'model' };
    assert.deepEqual([compactLaunch('claude-sonnet-5-5-20260101', model).window, compactLaunch('claude-sonnet-5-5-20260101', model).compactAt], [1_000_000, 800_000]);
    assert.equal(compactLaunch('claude-sonnet-5-5', model).window, 1_000_000);
    assert.equal(compactLaunch('claude-sonnet-4-6-20260101', model).window, 200_000);
    assert.equal(compactLaunch('claude-foo-9-20260101', model).window, 200_000);
  });
});

describe('compactLaunch: the S2 table', () => {
  // model, pct, window setting → [W, PCT env, compactAt]; PCT is always set ('100' above the cap, so an inherited value never stays)
  const TABLE = [
    [M2, 20, 'model', 200_000, '22.2223', 40_000], // S2 section 2: 200k / 20
    [M2, 80, 'model', 200_000, '88.8889', 160_000], // 200k / 80
    [M2, 95, 'model', 200_000, '100', 167_000], // 200k / 95: above the cap, PCT 100 makes Claude's cap W - 33000 the threshold
    [M1, 20, 'model', 1_000_000, '20.4082', 200_000], // 1M / 20
    [M1, 80, 'model', 1_000_000, '81.6327', 800_000], // 1M / 80
    [M1, 95, 'model', 1_000_000, '96.9388', 950_000], // 1M / 95
    [M1, 80, 400_000, 400_000, '84.2106', 320_000], // the default setting on a 1M model
    [M1, 95, 400_000, 400_000, '100', 367_000], // 400k / 95: cap 367k
    [M1, 80, 200_000, 200_000, '88.8889', 160_000], // a 200k choice on a 1M model
    [M2, 80, 400_000, 200_000, '88.8889', 160_000], // a 400k choice is limited to a 200k model's window
    [M2, 80, 1_000_000, 200_000, '88.8889', 160_000],
    [M1, 80, 1_000_000, 1_000_000, '81.6327', 800_000],
  ];
  for (const [model, pct, window, W, pctEnv, compactAt] of TABLE) {
    test(`(+) ${model} at ${pct} % of ${window}: window ${W}, PCT ${pctEnv}, compacts at ${compactAt}`, () => {
      const r = compactLaunch(model, ON(pct, window));
      assert.deepEqual(r, { env: { [WINDOW_ENV]: String(W), [PCT_ENV]: pctEnv }, window: W, compactAt });
    });
  }

  test('(+) the env names are the two Claude Code reads, window first', () => {
    assert.equal(WINDOW_ENV, 'CLAUDE_CODE_AUTO_COMPACT_WINDOW');
    assert.equal(PCT_ENV, 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE');
    assert.deepEqual(Object.keys(compactLaunch(M1, ON(80, 400_000)).env), [WINDOW_ENV, PCT_ENV]);
  });

  test('(+) the PCT is always set, "100" exactly when the target is above the cap (W - 33000), and the threshold never exceeds the cap', () => {
    for (const model of [M1, M2]) {
      for (const window of [200_000, 400_000, 1_000_000, 'model']) {
        for (let pct = 20; pct <= 95; pct++) {
          const r = compactLaunch(model, ON(pct, window));
          const target = Math.floor((r.window * pct) / 100);
          assert.ok(validPct(r.env[PCT_ENV]), `${model} ${window} ${pct}`);
          assert.equal(r.env[PCT_ENV] === '100', target > r.window - 33_000, `${model} ${window} ${pct}`);
          assert.equal(r.compactAt, Math.min(target, r.window - 33_000), `${model} ${window} ${pct}`);
          // what Claude Code computes from the env pair lands on the target, never below it and never more than 1 token per 10^4 above
          const effective = r.window - 20_000;
          const fires = Math.min(Math.floor((effective * Number(r.env[PCT_ENV])) / 100), effective - 13_000);
          if (target <= r.window - 33_000) assert.ok(fires >= target && fires - target <= 1 + effective / 1e6, `${model} ${window} ${pct}: ${fires} vs ${target}`);
          else assert.equal(fires, r.window - 33_000, `${model} ${window} ${pct}: PCT 100 lands on the cap`);
        }
      }
    }
  });

  test('(+) a custom or unknown model id is limited to 200k', () => {
    assert.deepEqual(compactLaunch('claude-foo-9', ON(80, 'model')), { env: { [WINDOW_ENV]: '200000', [PCT_ENV]: '88.8889' }, window: 200_000, compactAt: 160_000 });
    assert.equal(compactLaunch('claude-foo-9[1m]', ON(80, 'model')).window, 1_000_000);
  });

  test('(+) every PCT is digits and at most one dot, and in range', () => {
    for (const model of [M1, M2]) {
      for (const window of [200_000, 400_000, 1_000_000, 'model']) {
        for (let pct = 20; pct <= 95; pct++) {
          const v = compactLaunch(model, ON(pct, window)).env[PCT_ENV];
          assert.ok(validPct(v) && /^\d{1,3}(\.\d{1,4})?$/.test(v), `${v}`);
        }
      }
    }
  });
});

describe('compactLaunch: off and bad settings', () => {
  test('(+) off returns null, whatever the model', () => {
    for (const model of [M1, M2, 'claude-foo-9']) assert.equal(compactLaunch(model, { enabled: false, pct: 80, window: 400_000 }), null);
  });

  test('(−) a pct outside 20 to 95, a fraction or a non-number throws', () => {
    for (const pct of [19, 96, 0, 100, -1, 80.5, 19.99, NaN, Infinity, '80', null, undefined, [80], {}]) {
      assert.throws(() => compactLaunch(M1, ON(pct, 400_000)), { code: 'EINVAL' }, String(pct));
    }
    assert.equal(compactLaunch(M1, ON(20, 400_000)).window, 400_000);
    assert.equal(compactLaunch(M1, ON(95, 400_000)).window, 400_000);
  });

  test('(−) a window other than 200000, 400000, 1000000 or "model" throws', () => {
    for (const window of [100_000, 300_000, 400_001, 2_000_000, 0, -200_000, '400000', 'Model', 'auto', '', null, undefined, NaN, 400_000.5, [400_000]]) {
      assert.throws(() => compactLaunch(M1, ON(80, window)), { code: 'EINVAL' }, String(window));
    }
  });

  test('(−) a setting that is not an object with a boolean enabled throws', () => {
    for (const bad of [null, undefined, 5, 'on', [], { pct: 80, window: 400_000 }, { enabled: 'true', pct: 80, window: 400_000 }, { enabled: 1, pct: 80, window: 400_000 }]) {
      assert.throws(() => compactLaunch(M1, bad), { code: 'EINVAL' }, JSON.stringify(bad));
    }
  });
});

describe('compactEnv / validWindow / validPct: the check every launch passes (compactLaunch and _run-agent)', () => {
  test('(+) a window and a PCT string become the two variables', () => {
    assert.deepEqual(compactEnv(400_000, '84.2106'), { [WINDOW_ENV]: '400000', [PCT_ENV]: '84.2106' });
    assert.deepEqual(compactEnv(100_000, '100'), { [WINDOW_ENV]: '100000', [PCT_ENV]: '100' });
    assert.deepEqual(compactEnv(1_000_000, '0.0001'), { [WINDOW_ENV]: '1000000', [PCT_ENV]: '0.0001' });
  });

  test('(−) a window outside 100000 to 1000000, or not an integer, throws', () => {
    for (const w of [99_999, 1_000_001, 0, -1, 400_000.5, NaN, Infinity, '400000', null, undefined, [400_000], {}]) {
      assert.throws(() => compactEnv(w, '80'), { code: 'EINVAL' }, String(w));
      assert.equal(validWindow(w), false, String(w));
    }
  });

  test('(−) a PCT that is not digits with one dot, or is 0 or above 100, throws', () => {
    for (const p of ['', '0', '0.0', '0.0000', '100.0001', '101', '1000', '84.21061', '84.', '.5', '-5', '+5', '8e1', '0x50', ' 80', '80 ', '80\n', '8 0', '84,2', 84.2106, 80, undefined, [], {}, 'NaN', 'Infinity', '80;rm', '$HOME', null]) {
      assert.throws(() => compactEnv(400_000, p), { code: 'EINVAL' }, JSON.stringify(p));
      assert.equal(validPct(p), false, JSON.stringify(p));
    }
  });

  test('(+) validPct accepts the edges', () => {
    for (const p of ['0.0001', '1', '84.2106', '99.9999', '100', '100.0']) assert.equal(validPct(p), true, p);
  });
});
