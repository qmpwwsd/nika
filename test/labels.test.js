// Labels (0.5, W9): the list of kinds, the kind a spawn without `kind` gets from its model, and a Claude subagent's label from its
// agentType. Pure functions, synthetic data only (type names like security-reviewer).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { KINDS } from '../src/ids.js';
import { LABEL_MAX, ROLE_KIND, SUBAGENT_KIND, isKind, kindFromModel, subagentLabel } from '../src/labels.js';

const MODELS = { orchestrator: 'claude-fable-5-1', reasoner: 'claude-opus-5-5', builder: 'claude-sonnet-5-5', scout: 'claude-haiku-5-5' };
const points = (s) => Array.from(s).length;

describe('KINDS and isKind', () => {
  test('(+) KINDS is exactly the seven words, in the order of the spawn sheet', () => {
    assert.deepEqual(KINDS, ['coder', 'reviewer', 'tester', 'designer', 'scout', 'writer', 'agent']);
  });

  test('(+) isKind accepts each word of the list', () => {
    for (const k of KINDS) assert.equal(isKind(k), true, k);
  });

  test('(−) isKind refuses anything but an exact word: case, padding, other types, prototype names', () => {
    for (const v of ['Coder', 'coder ', ' coder', 'boss', '', 'sub-orchestrator', 'constructor', '__proto__', 'toString', null, undefined, 5, ['coder'], { toString: () => 'coder' }]) assert.equal(isKind(v), false, JSON.stringify(v));
  });

  test('(+) ROLE_KIND names a kind of the list for builder, reasoner and scout, and none for the orchestrator', () => {
    assert.deepEqual(ROLE_KIND, { builder: 'coder', reasoner: 'designer', scout: 'scout' });
    for (const k of Object.values(ROLE_KIND)) assert.ok(KINDS.includes(k), k);
    assert.equal(Object.hasOwn(ROLE_KIND, 'orchestrator'), false);
  });

  test('(+) every built-in subagent type maps to a word of the list', () => {
    for (const k of Object.values(SUBAGENT_KIND)) assert.ok(KINDS.includes(k), k);
  });

  test('(+) the file is ASCII only (the ellipsis is an escape), like src/text.js', () => {
    assert.match(fs.readFileSync(new URL('../src/labels.js', import.meta.url), 'utf8'), /^[\x00-\x7f]*$/);
  });
});

describe('kindFromModel', () => {
  test('(+) the builder model gives coder, the reasoner model designer, the scout model scout', () => {
    assert.equal(kindFromModel('claude-sonnet-5-5', MODELS), 'coder');
    assert.equal(kindFromModel('claude-opus-5-5', MODELS), 'designer');
    assert.equal(kindFromModel('claude-haiku-5-5', MODELS), 'scout');
  });

  test('(+) a reasoner and an orchestrator on one id still give designer: the orchestrator names no kind', () => {
    assert.equal(kindFromModel('claude-opus-5-5', { ...MODELS, orchestrator: 'claude-opus-5-5' }), 'designer');
  });

  test('(−) no role has the id: agent', () => {
    assert.equal(kindFromModel('claude-sonnet-4-1', MODELS), 'agent');
  });

  test('(−) builder and scout on one id name different kinds: agent', () => {
    assert.equal(kindFromModel('claude-sonnet-5-5', { ...MODELS, scout: 'claude-sonnet-5-5' }), 'agent');
  });

  test('(−) models null, undefined or empty: agent', () => {
    for (const models of [null, undefined, {}]) assert.equal(kindFromModel('claude-sonnet-5-5', models), 'agent', JSON.stringify(models));
  });

  test('(−) a model that is not a string: agent, even when a role holds undefined', () => {
    for (const model of [undefined, null, 5, ['claude-sonnet-5-5'], {}]) assert.equal(kindFromModel(model, { ...MODELS, builder: undefined }), 'agent', JSON.stringify(model));
    assert.equal(kindFromModel(undefined, {}), 'agent');
  });

  test('(−) no alias resolution: sonnet is not claude-sonnet-5-5', () => {
    assert.equal(kindFromModel('sonnet', MODELS), 'agent');
    assert.equal(kindFromModel('claude-sonnet-5-5[1m]', MODELS), 'agent');
  });

  test('(−) the orchestrator\'s id alone names no kind: agent', () => {
    assert.equal(kindFromModel('claude-fable-5-1', MODELS), 'agent');
  });
});

describe('subagentLabel', () => {
  test('(+) every built-in type of the table gives its kind', () => {
    const table = { Explore: 'scout', 'general-purpose': 'agent', Plan: 'designer', claude: 'agent', 'statusline-setup': 'coder', 'claude-code-guide': 'scout', 'web-fetch': 'scout', fork: 'agent' };
    assert.deepEqual(SUBAGENT_KIND, table);
    for (const [type, label] of Object.entries(table)) assert.equal(subagentLabel(type), label, type);
  });

  test('(+) a custom type shows its own name', () => {
    assert.equal(subagentLabel('security-reviewer'), 'security-reviewer');
    assert.equal(subagentLabel('  security-reviewer  '), 'security-reviewer');
  });

  test('(+) a plugin\'s agent plugin:name shows name', () => {
    assert.equal(subagentLabel('plugin:crew-code-reviewer'), 'crew-code-reviewer');
    assert.equal(subagentLabel('a:b:c'), 'c');
  });

  test('(+) a name over 24 code points is cut to 23 plus an ellipsis: 24 code points, the cut is the last character', () => {
    const label = subagentLabel('a-very-long-agent-type-name-of-thirty');
    assert.equal(points(label), LABEL_MAX);
    assert.equal(label, `a-very-long-agent-type-${String.fromCharCode(0x2026)}`);
    assert.equal(subagentLabel('x'.repeat(24)), 'x'.repeat(24), 'exactly 24 stays whole');
    assert.equal(points(subagentLabel('x'.repeat(25))), LABEL_MAX);
  });

  test('(+) the cut never splits a surrogate pair: an emoji at position 23 is kept whole or dropped whole', () => {
    const emoji = String.fromCodePoint(0x1f50d);
    for (const lead of [21, 22, 23, 24]) {
      const label = subagentLabel(`${'a'.repeat(lead)}${emoji}${'b'.repeat(10)}`);
      assert.equal(points(label), LABEL_MAX, `lead ${lead}`);
      assert.doesNotMatch(label, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/, `lead ${lead}: no lone surrogate`);
    }
    assert.equal(subagentLabel(`${'a'.repeat(22)}${emoji}${'b'.repeat(10)}`), `${'a'.repeat(22)}${emoji}${String.fromCharCode(0x2026)}`);
  });

  test('(−) missing, empty, blank or not a string: agent', () => {
    for (const v of [undefined, null, '', '   ', '\u0007\u001b', 5, {}, [], ['Explore'], true]) assert.equal(subagentLabel(v), 'agent', JSON.stringify(v));
  });

  test('(−) prototype names are names, not table hits', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) assert.equal(subagentLabel(name), name, name);
  });

  test('(−) the table is exact: another case or padded inside is a custom name, not a built-in', () => {
    assert.equal(subagentLabel('explore'), 'explore');
    assert.equal(subagentLabel('EXPLORE'), 'EXPLORE');
    assert.equal(subagentLabel('General-Purpose'), 'General-Purpose');
  });

  test('(−) escape sequences, controls and bidi marks never reach the label', () => {
    assert.equal(subagentLabel('\u001b[31mred-team\u001b[0m'), 'red-team');
    assert.equal(subagentLabel('\u001b]0;title\u0007checker'), 'checker');
    assert.equal(subagentLabel('qa\u202ereviewer'), 'qa reviewer');
    assert.equal(subagentLabel('qa\u200breviewer'), 'qa reviewer');
    assert.equal(subagentLabel('qa\nreviewer'), 'qa reviewer');
    assert.doesNotMatch(subagentLabel('a\u0000b\u007fc\u009bd'), /[\u0000-\u001f\u007f-\u009f]/);
  });

  test('(−) a type that is only a prefix keeps what it has: plugin: stays plugin:, and :x shows x', () => {
    assert.equal(subagentLabel('plugin:'), 'plugin:');
    assert.equal(subagentLabel('plugin: '), 'plugin:');
    assert.equal(subagentLabel(':x'), 'x');
    assert.equal(subagentLabel(':'), ':');
  });
});
