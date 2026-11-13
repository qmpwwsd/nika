// public/modes.js (permission-mode tag, switcher state, announcements, switch failures) and the mode tokens in
// public/tokens.css. The pure functions run in Node; modeEl runs on a tiny fake DOM, so the test also proves that
// server text only ever lands in text nodes and attributes. Design: docs/design/spec.md section 2.8 and 9.3.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODE_META, MODE_TARGETS, modeKey, modeEl, settingModeEl, bypassTag, switcherState, modeNote, switchFailure } from '../public/modes.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const TOKENS = read('public', 'tokens.css');

// ---- fake DOM (just what dom.js h() and icon() touch) ---------------------------------------------------------------

class FNode {
  constructor(tag, text = '') {
    this.tag = tag; this.text = text; this.kids = []; this.attrs = {}; this.className = '';
  }

  setAttribute(k, v) { this.attrs[k] = String(v); }

  getAttribute(k) { return this.attrs[k] ?? null; }

  append(...nodes) { this.kids.push(...nodes); }

  addEventListener() {}

  set textContent(v) { this.kids = []; this.text = String(v); }

  get textContent() { return this.text + this.kids.map((k) => k.textContent).join(''); }

  find(pred) {
    const out = [];
    const walk = (n) => { if (pred(n)) out.push(n); n.kids.forEach(walk); };
    walk(this);
    return out;
  }
}

let saved;
before(() => {
  saved = { document: globalThis.document, Node: globalThis.Node };
  globalThis.Node = FNode;
  globalThis.document = {
    createElement: (tag) => new FNode(tag),
    createElementNS: (ns, tag) => new FNode(tag),
    createTextNode: (t) => new FNode('#text', t),
  };
});
after(() => {
  globalThis.document = saved.document;
  globalThis.Node = saved.Node;
});

const MODES = ['manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk', 'unknown'];
const LABELS = { manual: 'Manual', acceptEdits: 'Accept edits', plan: 'Plan', auto: 'Auto', bypassPermissions: 'Bypass', dontAsk: "Don't ask", unknown: 'Mode ?' };

describe('MODE_META and MODE_TARGETS', () => {
  test('(+) every API mode has the spec label, its own class and its own icon', () => {
    assert.deepEqual(Object.keys(MODE_META), MODES);
    for (const m of MODES) assert.equal(MODE_META[m].label, LABELS[m], m);
    assert.equal(new Set(MODES.map((m) => MODE_META[m].cls)).size, MODES.length, 'one class per mode');
    assert.equal(new Set(MODES.map((m) => MODE_META[m].icon)).size, MODES.length, 'one icon per mode');
    assert.deepEqual(MODES.map((m) => MODE_META[m].cls), ['m-manual', 'm-edits', 'm-plan', 'm-auto', 'm-bypass', 'm-dontask', 'm-unknown']);
  });

  test('(−) the switcher targets are Manual, Accept edits, Plan, Auto: never Bypass or Don\'t ask', () => {
    assert.deepEqual(MODE_TARGETS, ['manual', 'acceptEdits', 'plan', 'auto']);
  });

  test('(−) modeKey passes only known modes; anything else, including prototype names, is unknown', () => {
    for (const m of MODES) assert.equal(modeKey(m), m);
    for (const bad of ['__proto__', 'toString', 'constructor', 'default', 'Plan', '', null, undefined, 42, {}, ['plan']]) assert.equal(modeKey(bad), 'unknown', String(bad));
  });
});

describe('modeEl', () => {
  const textOf = (el) => el.textContent;
  const icons = (el) => el.find((n) => n.tag === 'svg');

  test('(+) renders the label text and an icon for every mode', () => {
    for (const m of MODES) {
      const el = modeEl(m, { confirmed: true });
      assert.equal(el.tag, 'span');
      assert.equal(el.className, `mode ${MODE_META[m].cls}`);
      assert.match(textOf(el), new RegExp(`Permission mode: ${LABELS[m].replace('?', '\\?')}`), m);
      const [svg] = icons(el);
      assert.ok(svg, `${m} has an icon`);
      assert.equal(svg.getAttribute('aria-hidden'), 'true');
      assert.equal(svg.kids[0].getAttribute('href'), `#i-${MODE_META[m].icon}`);
      assert.equal(el.getAttribute('data-confirmed'), 'true');
      assert.equal(el.getAttribute('title'), `Permission mode: ${LABELS[m]}`);
      assert.equal(el.find((n) => n.className === 'ml')[0].textContent, LABELS[m]);
      assert.equal(el.find((n) => n.className === 'mnote').length, 0, 'a confirmed tag has no note');
    }
  });

  test('(+) bypassTag is the confirmed Bypass tag, the same element modeEl builds for that mode (colour class, icon, label)', () => {
    const tag = bypassTag();
    const want = modeEl('bypassPermissions');
    assert.equal(tag.className, want.className);
    assert.equal(tag.className, 'mode m-bypass');
    assert.equal(tag.textContent, want.textContent);
    assert.equal(tag.getAttribute('data-confirmed'), 'true');
    assert.equal(icons(tag)[0].kids[0].getAttribute('href'), '#i-m-bypass');
  });

  test('(−) bypassTag does not depend on the order or class names of the other modes: no other mode produces it', () => {
    for (const m of MODES.filter((k) => k !== 'bypassPermissions')) assert.notEqual(modeEl(m).className, bypassTag().className, m);
  });

  test('(+) the screen-reader prefix is sr-only and the label is its own span', () => {
    const el = modeEl('plan');
    assert.equal(el.find((n) => n.className === 'sr-only')[0].textContent, 'Permission mode: ');
  });

  test('(+) unconfirmed sets data-confirmed="false", shows the word and explains it in the title', () => {
    const el = modeEl('plan', { confirmed: false });
    assert.equal(el.getAttribute('data-confirmed'), 'false');
    assert.equal(el.find((n) => n.className === 'mnote')[0].textContent, 'unconfirmed');
    assert.equal(el.getAttribute('title'), "Permission mode: Plan (not confirmed: Claude's footer is covered or not shown yet)");
  });

  test('(+) compact: an unconfirmed tag keeps the word for screen readers and the title, not on screen, after a separator', () => {
    const el = modeEl('auto', { confirmed: false, compact: true });
    assert.equal(el.find((n) => n.className === 'mnote').length, 0);
    assert.ok(el.find((n) => n.className === 'sr-only' && n.textContent === ', unconfirmed').length === 1);
    assert.equal(textOf(el), 'Permission mode: Auto, unconfirmed', 'the text reads as one phrase, not "Autounconfirmed"');
    assert.match(el.getAttribute('title'), /not confirmed/);
    assert.equal(el.getAttribute('data-confirmed'), 'false');
  });

  test('(+) icon-only keeps the same phrase; the full tag shows the bare word on screen', () => {
    assert.equal(textOf(modeEl('manual', { confirmed: false, iconOnly: true })), 'Permission mode: Manual, unconfirmed');
    const full = modeEl('plan', { confirmed: false });
    assert.equal(full.find((n) => n.className === 'mnote')[0].textContent, 'unconfirmed', 'the visible note has no separator');
  });

  test('(−) a confirmed tag never says unconfirmed, in any variant', () => {
    for (const opts of [{}, { compact: true }, { iconOnly: true }, { confirmed: true, compact: true }]) {
      assert.doesNotMatch(textOf(modeEl('plan', opts)), /unconfirmed/, JSON.stringify(opts));
    }
  });

  test('(+) iconOnly: the label moves to sr-only and the tag gets the icon-only class', () => {
    const el = modeEl('manual', { iconOnly: true });
    assert.equal(el.className, 'mode m-manual icon-only');
    assert.equal(el.find((n) => n.className === 'ml').length, 0);
    assert.match(textOf(el), /Manual/);
    assert.equal(el.find((n) => n.tag === 'span' && n.className === 'sr-only' && n.textContent === 'Manual').length, 1);
  });

  test('(−) an unknown or hostile mode falls back to "Mode ?"; text never becomes markup', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    for (const bad of [hostile, '__proto__', null, undefined, 7]) {
      const el = modeEl(bad);
      assert.equal(el.className, 'mode m-unknown');
      assert.doesNotMatch(textOf(el), /img|onerror|alert/);
      assert.equal(el.getAttribute('title'), 'Permission mode: Mode ?');
    }
  });
});

// ---- settingModeEl: a Settings value on a card (F6) -------------------------------------------------------------------

describe('settingModeEl (the project page\'s New agents card)', () => {
  const textOf = (el) => el.textContent;
  const icons = (el) => el.find((n) => n.tag === 'svg');

  test('(+) a mode a pane can be in gives exactly the chip modeEl builds: same class, icon, label and title', () => {
    for (const m of ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk']) {
      const a = settingModeEl(m);
      const b = modeEl(m);
      assert.equal(a.className, b.className, m);
      assert.equal(textOf(a), textOf(b), m);
      assert.equal(a.getAttribute('title'), b.getAttribute('title'), m);
      assert.equal(icons(a)[0].kids[0].getAttribute('href'), icons(b)[0].kids[0].getAttribute('href'), m);
    }
  });

  test('(+) default (Claude Code\'s own default, no flag) is a chip of its own: the word Default, the gear icon, the neutral Manual colour', () => {
    const el = settingModeEl('default');
    assert.equal(el.className, 'mode m-manual');
    assert.equal(el.find((n) => n.className === 'ml')[0].textContent, 'Default');
    assert.equal(icons(el)[0].kids[0].getAttribute('href'), '#i-gear');
    assert.equal(el.getAttribute('title'), 'Permission mode: Default');
    assert.equal(textOf(el), 'Permission mode: Default');
    assert.notEqual(icons(el)[0].kids[0].getAttribute('href'), `#i-${MODE_META.manual.icon}`, 'not the Manual icon: the two are told apart without colour');
    assert.match(read('public', 'index.html'), /<symbol id="i-gear"/, 'the icon exists in the sprite');
  });

  test('(−) default stays out of MODE_META: a pane can never be in it, so modeKey still calls it unknown', () => {
    assert.equal(Object.hasOwn(MODE_META, 'default'), false);
    assert.equal(modeKey('default'), 'unknown');
    assert.equal(modeEl('default').className, 'mode m-unknown');
  });

  test('(−) a value that is not a setting falls back to "Mode ?", and text never becomes markup', () => {
    for (const bad of ['<img src=x onerror=alert(1)>', '__proto__', 'toString', null, undefined, 7]) {
      const el = settingModeEl(bad);
      assert.equal(el.className, 'mode m-unknown');
      assert.doesNotMatch(textOf(el), /img|onerror|alert/);
    }
  });

  test('(+) the chip is confirmed (a setting has no footer to read): no unconfirmed note', () => {
    assert.equal(settingModeEl('plan').getAttribute('data-confirmed'), 'true');
    assert.doesNotMatch(textOf(settingModeEl('default')), /unconfirmed/);
  });
});

// ---- tokens.css ---------------------------------------------------------------------------------------------------

describe('tokens.css mode tokens', () => {
  const blockAt = (css, opener) => {
    const at = css.indexOf(opener);
    assert.ok(at >= 0, `${opener} exists`);
    const open = css.indexOf('{', at);
    return css.slice(open + 1, css.indexOf('}', open));
  };
  const BLOCKS = {
    light: blockAt(TOKENS, ':root {'),
    dark: blockAt(TOKENS, ':root:not([data-theme="light"]) {'),
    darkPinned: blockAt(TOKENS, ':root[data-theme="dark"] {'),
  };
  const vars = (block) => Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const TOKEN_NAMES = [...MODES.flatMap((m) => {
    const base = `--m-${MODE_META[m].cls.slice(2)}`;
    return [base, `${base}-soft`, `${base}-line`];
  }), '--m-bypass-on', '--m-bypass-stripe'];

  test('(+) every MODE_META cls has a rule in tokens.css that reads that mode\'s three tokens', () => {
    for (const m of MODES) {
      const { cls } = MODE_META[m];
      const rule = new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`).exec(TOKENS);
      assert.ok(rule, `.${cls} rule`);
      const t = cls.slice(2);
      assert.match(rule[1], new RegExp(`--mc:\\s*var\\(--m-${t}\\)`));
      assert.match(rule[1], new RegExp(`--mc-soft:\\s*var\\(--m-${t}-soft\\)`));
      assert.match(rule[1], new RegExp(`--mc-line:\\s*var\\(--m-${t}-line\\)`));
    }
  });

  test('(+) every --m-* token is defined in the light block and in both dark blocks', () => {
    assert.equal(TOKEN_NAMES.length, 23);
    for (const [name, block] of Object.entries(BLOCKS)) {
      const defined = vars(block);
      for (const t of TOKEN_NAMES) assert.match(defined[t] ?? '', /^#[0-9a-f]{6}$/i, `${t} in ${name}`);
    }
  });

  test('(+) both dark blocks hold identical mode tokens', () => {
    const [a, b] = [vars(BLOCKS.dark), vars(BLOCKS.darkPinned)];
    for (const t of TOKEN_NAMES) assert.equal(a[t], b[t], t);
  });

  test('(+) the .mode, .msw and held rules exist; the tag is hollow and dashed when unconfirmed', () => {
    assert.match(TOKENS, /\.mode\s*\{/);
    assert.match(TOKENS, /\.mode\[data-confirmed="false"\]/);
    assert.match(TOKENS, /\.mode\.m-bypass\[data-confirmed="false"\]\s*\{\s*border-style:\s*solid/);
    assert.match(TOKENS, /\.msw\s*\{/);
    assert.match(TOKENS, /\.msw button\.held\s*\{[^}]*dashed/);
    assert.match(TOKENS, /\.msw-why\.err\s*\{/);
  });

  // WCAG 2.x relative luminance, so a typo in a hex digit fails here instead of in a user's eyes (spec 2.8.2: 0 failures)
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  for (const [name, block] of Object.entries(BLOCKS)) {
    test(`(+) contrast (${name}): text 4.5:1 on soft, surface and attention rows; edges 3:1 on bg, surface and surface-2`, () => {
      const v = { ...vars(BLOCKS.light), ...vars(block) };
      for (const m of MODES) {
        const t = `--m-${MODE_META[m].cls.slice(2)}`;
        const text = m === 'bypassPermissions' ? v['--m-bypass'] : v[t];
        for (const ground of [v[`${t}-soft`], v['--surface'], v['--attn-row']]) assert.ok(ratio(text, ground) >= 4.5, `${m} text on ${ground}: ${ratio(text, ground).toFixed(2)}`);
        for (const ground of [v['--bg'], v['--surface'], v['--surface-2']]) assert.ok(ratio(v[`${t}-line`], ground) >= 3, `${m} edge on ${ground}: ${ratio(v[`${t}-line`], ground).toFixed(2)}`);
      }
      assert.ok(ratio(v['--m-bypass-on'], v['--m-bypass']) >= 4.5, 'bypass fill text');
      for (const ground of [v['--bg'], v['--surface']]) {
        assert.ok(ratio(v['--m-bypass'], ground) >= 3, 'bypass fill edge');
        assert.ok(ratio(v['--m-bypass-stripe'], ground) >= 3, 'bypass stripe');
      }
    });
  }

  test('(−) tokens.css stays free of color-mix(), :has() and non-ASCII', () => {
    const css = TOKENS.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(css, /color-mix\(|:has\(/);
    assert.equal([...TOKENS].every((ch) => ch.codePointAt(0) < 128), true);
  });
});

// ---- switcherState ------------------------------------------------------------------------------------------------

describe('switcherState', () => {
  const base = { pane: 'ok', status: 'idle', prompt: null, mode: 'plan', modeConfirmed: true, switching: null };
  const S = (over) => switcherState({ ...base, ...over });
  const PROMPT = { question: 'Do you want to proceed?', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }], sig: '0123456789abcdef' };
  const WHY = {
    prompt: 'Answer the prompt first.',
    working: 'Switch when Claude is waiting for you.',
    unconfirmed: 'Waiting for Claude to confirm the mode.',
    unknown: "nika can't read the mode. Use the terminal.",
    dontAsk: "Don't ask is on. Change it in the terminal.",
    switching: `Switching${String.fromCharCode(0x2026)} up to 6 Shift-Tab presses.`,
  };

  test('(+) ready: Claude idle, no prompt, confirmed mode: live, the current segment pressed, no reason', () => {
    for (const mode of MODE_TARGETS) assert.deepEqual(S({ mode }), { disabled: false, pressed: mode, held: null, reason: '', chip: null, busy: null });
  });

  test('(+) a prompt (or status Needs you): reason, no chip, the held segment, all disabled; it wins over working, unconfirmed and unknown', () => {
    const want = (held, tag) => ({ disabled: true, pressed: null, held, reason: WHY.prompt, chip: null, busy: null, ...(tag ? { tag } : {}) });
    assert.deepEqual(S({ prompt: PROMPT, modeConfirmed: false }), want('plan'));
    assert.deepEqual(S({ status: 'attn' }), want('plan'), 'status Needs you alone is enough');
    assert.deepEqual(S({ prompt: PROMPT, status: 'busy' }), want('plan'), 'over working');
    assert.deepEqual(S({ prompt: PROMPT, mode: 'unknown' }), want(null), 'over unknown: no chip even then');
    assert.deepEqual(S({ prompt: PROMPT, status: 'attn', mode: 'auto', modeConfirmed: false, switching: 'plan' }), want('auto'), 'over switching');
    assert.deepEqual(S({ prompt: PROMPT, mode: 'dontAsk', modeConfirmed: false }), want(null, 'dontAsk'), 'a held Don\'t ask has no segment, its tag leads the reason line');
    assert.deepEqual(S({ prompt: PROMPT, mode: 'bypassPermissions', modeConfirmed: false }), want(null, 'bypassPermissions'), 'a held Bypass has no segment, its tag leads the reason line');
  });

  test('(+) Claude working: all disabled, the pressed segment stays pressed', () => {
    assert.deepEqual(S({ status: 'busy' }), { disabled: true, pressed: 'plan', held: null, reason: WHY.working, chip: null, busy: null });
    assert.equal(S({ status: 'busy', modeConfirmed: false }).reason, WHY.working, 'working wins over unconfirmed');
    assert.equal(S({ status: 'busy', modeConfirmed: false }).held, 'plan');
    assert.equal(S({ status: 'busy', mode: 'unknown' }).chip, null, 'working wins over unknown: no chip');
  });

  test('(+) unconfirmed: the held segment, nothing pressed, all disabled', () => {
    assert.deepEqual(S({ modeConfirmed: false }), { disabled: true, pressed: null, held: 'plan', reason: WHY.unconfirmed, chip: null, busy: null });
    assert.equal(S({ modeConfirmed: false, mode: 'unknown' }).chip, null, 'unconfirmed wins over unknown');
    assert.equal(S({ modeConfirmed: false, mode: 'dontAsk' }).held, null);
  });

  test('(+) m6: unknown mode with nothing held or launched: nothing pressed, all disabled, no chip, the terminal is the way', () => {
    assert.deepEqual(S({ mode: 'unknown' }), { disabled: true, pressed: null, held: null, reason: WHY.unknown, chip: null, busy: null });
  });

  test('(−) m6: a held or launch mode (unconfirmed) is not "unknown": it keeps its own reason and its segment, and no chip either', () => {
    const st = S({ mode: 'plan', modeConfirmed: false });
    assert.equal(st.reason, WHY.unconfirmed);
    assert.equal(st.held, 'plan');
    assert.equal(st.chip, null);
  });

  test('(−) hostile mode strings read as unknown (no chip, nothing pressed)', () => {
    for (const mode of ['__proto__', 'toString', 'Plan', 7, null, undefined]) {
      const st = S({ mode });
      assert.equal(st.reason, WHY.unknown, String(mode));
      assert.equal(st.pressed, null);
      assert.equal(st.chip, null);
    }
  });

  test('(−) no state of the switcher ever offers the Shift-Tab chip', () => {
    for (const mode of [...MODES, 'unknown', 'nonsense']) {
      for (const status of [null, 'idle', 'busy', 'attn', 'ended']) {
        for (const modeConfirmed of [true, false]) {
          for (const prompt of [null, PROMPT]) assert.equal(S({ mode, status, modeConfirmed, prompt }).chip, null, `${mode} ${status} ${modeConfirmed} ${prompt ? 'prompt' : ''}`);
        }
      }
    }
  });

  test('(−) Don\'t ask current: all disabled, none pressed, no chip, its tag leads the reason line', () => {
    assert.deepEqual(S({ mode: 'dontAsk' }), { disabled: true, pressed: null, held: null, reason: WHY.dontAsk, chip: null, busy: null, tag: 'dontAsk' });
  });

  test('(−) a Bypass footer: no Bypass segment, the four segments usable, none pressed, no reason', () => {
    const st = S({ mode: 'bypassPermissions' });
    assert.deepEqual(st, { disabled: false, pressed: null, held: null, reason: '', chip: null, busy: null, tag: 'bypassPermissions', note: 'Claude runs every tool without asking.' });
    assert.ok(!MODE_TARGETS.includes('bypassPermissions'));
    assert.equal(S({ mode: 'bypassPermissions', status: 'busy' }).disabled, true, 'but not while Claude is working');
  });

  test('(+) switching: the target is busy, the rest disabled, the pressed segment follows the footer', () => {
    assert.deepEqual(S({ switching: 'auto' }), { disabled: true, pressed: 'plan', held: null, reason: WHY.switching, chip: null, busy: 'auto' });
    assert.equal(S({ switching: 'auto', mode: 'acceptEdits' }).pressed, 'acceptEdits');
    assert.equal(S({ switching: 'auto', mode: 'unknown' }).pressed, null, 'a mid-cycle unreadable footer presses nothing');
    assert.equal(S({ switching: 'auto', mode: 'unknown' }).chip, null);
  });

  test('(+) 0.3.3: a mode with no segment (Bypass, Don\'t ask) carries its tag in every state where the pane is ok: prompt, working, switching, unconfirmed, ready', () => {
    for (const mode of ['bypassPermissions', 'dontAsk']) {
      for (const over of [{ prompt: PROMPT }, { status: 'attn' }, { status: 'busy' }, { status: 'ended' }, { switching: 'auto' }, { modeConfirmed: false }, {}]) {
        assert.equal(S({ mode, ...over }).tag, mode, `${mode} ${JSON.stringify(over)}`);
      }
    }
  });

  test('(−) 0.3.3: no tag for Manual, Accept edits, Plan, Auto or an unknown mode, and none when the pane is off', () => {
    for (const mode of [...MODE_TARGETS, 'unknown', 'nonsense', '__proto__']) {
      for (const over of [{ prompt: PROMPT }, { status: 'busy' }, { switching: 'auto' }, { modeConfirmed: false }, {}]) {
        assert.equal(Object.hasOwn(S({ mode, ...over }), 'tag'), false, `${mode} ${JSON.stringify(over)}`);
      }
    }
    for (const pane of ['gone', 'tmux', 'connecting']) {
      for (const mode of ['bypassPermissions', 'dontAsk']) assert.equal(Object.hasOwn(S({ pane, mode }), 'tag'), false, `${pane} ${mode}`);
    }
  });

  test('(−) 0.3.3: the live-Bypass note exists only for a live Bypass: not while working, held, switching, a prompt, Don\'t ask or any segment mode', () => {
    assert.equal(S({ mode: 'bypassPermissions' }).note, 'Claude runs every tool without asking.');
    for (const over of [{ mode: 'bypassPermissions', status: 'busy' }, { mode: 'bypassPermissions', prompt: PROMPT }, { mode: 'bypassPermissions', switching: 'auto' }, { mode: 'bypassPermissions', modeConfirmed: false },
      { mode: 'dontAsk' }, { mode: 'unknown' }, { mode: 'plan' }, { pane: 'gone', mode: 'bypassPermissions' }]) {
      assert.equal(Object.hasOwn(S(over), 'note'), false, JSON.stringify(over));
    }
  });

  test('(+) the pane rows come first: gone, tmux error, no capture yet; no segment pressed, no chip', () => {
    const dead = (reason) => ({ disabled: true, pressed: null, held: null, reason, chip: null, busy: null });
    for (const over of [{}, { prompt: PROMPT }, { status: 'attn' }, { status: 'busy' }, { mode: 'unknown' }, { switching: 'auto' }]) {
      assert.deepEqual(S({ pane: 'gone', ...over }), dead('The pane is gone.'));
      assert.deepEqual(S({ pane: 'tmux', ...over }), dead("nika couldn't reach tmux."));
      assert.deepEqual(S({ pane: 'connecting', ...over }), dead(`Connecting to the pane${String.fromCharCode(0x2026)}`));
    }
  });

  test('(+) a status that is not known yet leaves the server to decide (it answers 409 not-idle)', () => {
    assert.equal(S({ status: null }).disabled, false);
    assert.equal(S({ status: undefined }).disabled, false);
    assert.equal(S({ status: 'ended' }).reason, WHY.working);
  });
});

// ---- modeNote: what #mode-live says --------------------------------------------------------------------------------

describe('modeNote', () => {
  const N = (last, mode, confirmed = true) => modeNote('builder-1', last, { mode, confirmed });

  test('(+) a confirmed mode at open is silent; an unconfirmed one says so', () => {
    assert.deepEqual(N(null, 'plan'), { last: 'plan', msg: '' });
    assert.deepEqual(N(null, 'plan', false), { last: 'plan', msg: 'builder-1 started in Plan mode, not confirmed yet.' });
  });

  test('(+) a change says the new mode; Bypass adds the loud sentence, also at open', () => {
    assert.deepEqual(N('plan', 'auto'), { last: 'auto', msg: 'builder-1: permission mode is now Auto.' });
    assert.equal(N('plan', 'bypassPermissions').msg, 'builder-1: permission mode is now Bypass. Claude runs every tool without asking.');
    assert.equal(N(null, 'bypassPermissions').msg, 'builder-1: permission mode is now Bypass. Claude runs every tool without asking.');
    assert.equal(N(null, 'bypassPermissions', false).msg, 'builder-1: permission mode is now Bypass. Claude runs every tool without asking.');
  });

  test('(−) the same mode confirmed or not, and unknown on the way, are silent', () => {
    assert.equal(N('plan', 'plan', false).msg, '');
    assert.equal(N('plan', 'plan', true).msg, '');
    assert.deepEqual(N('plan', 'unknown'), { last: 'plan', msg: '' }, 'becomes unknown');
    assert.deepEqual(N('plan', 'plan'), { last: 'plan', msg: '' }, 'unknown back to the same mode');
    assert.equal(N('plan', 'auto').msg, 'builder-1: permission mode is now Auto.', 'unknown back to a different mode is a change');
    assert.deepEqual(N(null, 'unknown'), { last: null, msg: '' }, 'nothing read yet');
  });
});

// ---- switchFailure: what a failed switch says once the next capture is in -----------------------------------------------

describe('switchFailure', () => {
  const F = (over) => switchFailure({ status: 409, code: 'not-in-cycle', start: 'manual', target: 'auto', mode: 'manual', confirmed: true, ...over });

  test('(+) Stopped at <mode>: any failure whose next capture reads a confirmed mode other than the start mode', () => {
    assert.deepEqual(F({ mode: 'acceptEdits' }), { text: 'Stopped at Accept edits.', strike: null });
    assert.deepEqual(F({ code: 'not-idle', mode: 'plan' }), { text: 'Stopped at Plan.', strike: null });
    assert.deepEqual(F({ status: 429, code: undefined, mode: 'plan' }), { text: 'Stopped at Plan.', strike: null });
    assert.deepEqual(F({ status: 500, code: undefined, mode: 'bypassPermissions' }), { text: 'Stopped at Bypass.', strike: null });
  });

  test('(+) not-in-cycle with the next capture back at the start mode: the message and the strike', () => {
    assert.deepEqual(F({}), { text: "Auto isn't in this session's Shift-Tab cycle.", strike: 'auto' });
    assert.deepEqual(F({ start: 'plan', mode: 'plan', target: 'manual' }), { text: "Manual isn't in this session's Shift-Tab cycle.", strike: 'manual' });
  });

  test('(−) no strike and no "Stopped at" from a capture that is unconfirmed or unknown', () => {
    assert.deepEqual(F({ confirmed: false, mode: 'plan' }), { text: "Auto isn't in this session's Shift-Tab cycle.", strike: null });
    assert.deepEqual(F({ mode: 'unknown' }), { text: "Auto isn't in this session's Shift-Tab cycle.", strike: null });
    assert.equal(F({ code: 'not-idle', mode: 'unknown' }).text, 'Switch when Claude is waiting for you.');
  });

  test('(+) the other responses, exact copy (mode still at the start)', () => {
    const T = (over) => F({ mode: 'manual', ...over }).text;
    assert.equal(T({ code: 'not-idle' }), 'Switch when Claude is waiting for you.');
    assert.equal(T({ code: 'mode-unknown' }), "nika can't read the mode.");
    assert.equal(T({ code: 'busy-switching' }), 'Another action is running on this session.');
    assert.equal(T({ status: 404, code: 'not_found' }), 'The session is gone.');
    assert.equal(T({ status: 429, code: undefined }), 'Too many keys at once; try again.');
    assert.equal(T({ status: 500, code: undefined }), "nika couldn't reach tmux.");
    assert.equal(T({ status: 502, code: undefined }), "nika couldn't reach tmux.");
    assert.equal(T({ status: 0, code: undefined }), "nika couldn't reach tmux.");
  });

  test('(+) mode-unchanged: a calm line, no alert, no Bypass tag, no strike (the footer read fine and did not move)', () => {
    const calm = { text: "The mode didn't change; try again or use the terminal.", strike: null };
    assert.deepEqual(F({ code: 'mode-unchanged', mode: 'manual', presses: 1 }), calm);
    assert.deepEqual(F({ code: 'mode-unchanged', mode: 'manual', presses: 3 }), calm);
    assert.deepEqual(F({ code: 'mode-unchanged', mode: 'unknown', confirmed: true }), calm, 'the capture after it is covered by a dialog');
    assert.equal(F({ code: 'mode-unchanged', mode: 'manual', presses: 1 }).loud, undefined);
    assert.equal(F({ code: 'mode-unchanged', mode: 'manual', presses: 1 }).bypass, undefined);
  });

  test('(−) mode-unchanged: a confirmed mode other than the start still wins ("Stopped at"), 404 still wins, other statuses are not it, mode-unknown keeps its alert', () => {
    assert.deepEqual(F({ code: 'mode-unchanged', mode: 'plan', presses: 1 }), { text: 'Stopped at Plan.', strike: null });
    assert.equal(F({ status: 404, code: 'mode-unchanged', mode: 'manual' }).text, 'The session is gone.');
    assert.equal(F({ status: 500, code: 'mode-unchanged', mode: 'manual' }).text, "nika couldn't reach tmux.");
    assert.equal(F({ status: 400, code: 'mode-unchanged', mode: 'manual' }).text, "nika couldn't switch the mode.");
    const loud = F({ code: 'mode-unknown', mode: 'manual', presses: 1 });
    assert.equal(loud.loud, true);
    assert.match(loud.text, /including Bypass permissions/);
  });

  test('(+) H1: 409 stopped-in-bypass is loud, with the Bypass tag, and tells the user how to leave it', () => {
    const want = { text: 'Stopped at Bypass permissions: Claude runs tools without asking. Press Shift-Tab in the terminal to leave it.', strike: null, loud: true, bypass: true };
    assert.deepEqual(F({ code: 'stopped-in-bypass', mode: 'bypassPermissions' }), want, 'the next capture reads Bypass');
    assert.deepEqual(F({ code: 'stopped-in-bypass', mode: 'unknown' }), want, 'the footer is unreadable: the route\'s last reading was Bypass');
    assert.deepEqual(F({ code: 'stopped-in-bypass', mode: 'plan', confirmed: false }), want, 'an unconfirmed capture proves nothing');
    assert.deepEqual(F({ code: 'stopped-in-bypass', start: 'bypassPermissions', mode: 'bypassPermissions' }), want, 'it started in Bypass too');
    assert.deepEqual(F({ code: 'stopped-in-bypass', mode: 'bypassPermissions', presses: 3 }), want);
  });

  test('(+) stopped-in-bypass is loud even when the next capture already reads another confirmed mode: the route saw Bypass last, so the alarm is never dropped', () => {
    assert.deepEqual(F({ code: 'stopped-in-bypass', mode: 'plan' }).loud, true);
    assert.equal(F({ code: 'stopped-in-bypass', mode: 'plan' }).bypass, true);
  });

  test('(−) 404 beats stopped-in-bypass; other statuses with that code are not it; the Bypass tag is only for stopped-in-bypass', () => {
    assert.equal(F({ status: 404, code: 'stopped-in-bypass', mode: 'bypassPermissions' }).text, 'The session is gone.');
    assert.equal(F({ status: 400, code: 'stopped-in-bypass', mode: 'manual' }).text, "nika couldn't switch the mode.");
    assert.equal(F({ status: 500, code: 'stopped-in-bypass', mode: 'manual' }).text, "nika couldn't reach tmux.");
    for (const over of [{ code: 'mode-unknown', presses: 2, mode: 'manual' }, { code: 'not-idle', mode: 'manual' }, { status: 500, code: undefined, mode: 'manual' }]) assert.equal(F(over).bypass, undefined, JSON.stringify(over));
  });

  test('(+) H1: 409 mode-unknown after at least one press is loud and says Claude may be in any mode, Bypass included', () => {
    const want = { text: "nika can't read the mode after pressing Shift-Tab. Check the terminal: the session may be in any mode, including Bypass permissions.", strike: null, loud: true };
    for (const presses of [1, 2, 6]) assert.deepEqual(F({ code: 'mode-unknown', mode: 'manual', presses }), want, String(presses));
    assert.deepEqual(F({ code: 'mode-unknown', mode: 'unknown', presses: 1 }), want);
  });

  test('(−) mode-unknown with no press (0, absent, not a count) keeps today\'s plain line and stays quiet', () => {
    for (const presses of [0, undefined, null, -1, 1.5, '2', NaN]) {
      assert.deepEqual(F({ code: 'mode-unknown', mode: 'manual', presses }), { text: "nika can't read the mode.", strike: null }, String(presses));
    }
  });

  test('(−) mode-unknown after presses still gives way to a confirmed capture at another mode', () => {
    assert.deepEqual(F({ code: 'mode-unknown', mode: 'acceptEdits', presses: 2 }), { text: 'Stopped at Accept edits.', strike: null });
  });

  test('(−) 404 says the session is gone whatever the capture shows; unlisted answers get a plain fallback; none strikes', () => {
    assert.equal(F({ status: 404, code: 'not_found', mode: 'plan' }).text, 'The session is gone.');
    for (const over of [{ status: 400, code: 'invalid' }, { status: 409, code: 'something-new' }, { status: 403, code: undefined }]) {
      const r = F({ mode: 'manual', ...over });
      assert.equal(r.text, "nika couldn't switch the mode.", JSON.stringify(over));
      assert.equal(r.strike, null);
    }
    for (const code of ['not-idle', 'mode-unknown', 'busy-switching']) assert.equal(F({ code, mode: 'manual' }).strike, null, code);
  });
});

describe('serving', () => {
  test('(+) the server serves /modes.js as JavaScript, next to the other public modules', () => {
    assert.match(read('src', 'server.js'), /\['\/modes\.js', \['modes\.js', 'text\/javascript; charset=utf-8'\]\]/);
  });

  test('(−) modes.js imports only dom.js, and does no network, storage or timer work', () => {
    const src = read('public', 'modes.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    assert.deepEqual([...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]), ['./dom.js']);
    assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|localStorage|sessionStorage|setTimeout|setInterval|document\.cookie/);
  });
});
