// T14/T17: nothing private may be committed. Scans every candidate file in the repo for home paths, scratchpad paths,
// emails, real-looking session ids and UUIDs, API keys and .local hosts. Fixtures use only repeated-digit UUIDs.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Design variants and mock data are scanned too: they must use synthetic paths like `~/projects/demo`.
const EXCLUDE_DIRS = new Set(['.git', 'node_modules', path.join('app', 'src-tauri', 'target')]);
const BINARY = /\.(png|jpe?g|gif|ico|icns|woff2?|pdf|zip|gz)$/i;

/** A fixture UUID uses at most two distinct hex chars besides the version and variant nibbles. */
function isSyntheticUuid(u) {
  const hex = u.replace(/-/g, '');
  return new Set(hex.slice(0, 12) + hex.slice(13, 16) + hex.slice(17)).size <= 2;
}

// The one path under the home roots that is not a person's folder: Linuxbrew's install prefix `<home root>/linuxbrew/.linuxbrew`
// (a candidate path for node), followed only by ordinary segments. A `..` segment anywhere after it, or a longer name
// (`.linuxbrew-x`, `linuxbrew-x`), is not the prefix: the path may lead anywhere, so it is reported.
const LINUXBREW_PREFIX = String.raw`linuxbrew\/\.linuxbrew(?:\/(?!\.\.(?![A-Za-z0-9_.-]))[A-Za-z0-9_.-]+)*(?![\/A-Za-z0-9_.-])`;

// [label, pattern, allow(match) → true to ignore]
const PATTERNS = [
  ['home path', new RegExp(String.raw`\/(?:Users|home)\/(?!${LINUXBREW_PREFIX})[A-Za-z0-9_.-]+`, 'g')],
  ['claude scratchpad', /\/private\/tmp\/claude-\d+/g],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['session id', /\b(?:session|cse)_[A-Za-z0-9]{11,}/g],
  ['uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, isSyntheticUuid],
  ['api key', /sk-ant[-]/g],
  // `settings.local.json` is a file name, not a host; `MacBook.local` is the generic tmux-title fixture in test/helpers.js
  ['.local host', /\b[A-Za-z0-9-]+\.local\b(?!\.)/g, (m) => m.endsWith('MacBook.local')],
];

function* walk(root, rel = '') {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (EXCLUDE_DIRS.has(r)) continue;
    if (e.isDirectory()) yield* walk(root, r);
    else if (e.isFile() && !BINARY.test(e.name)) yield r;
  }
}

/** Returns [{ file, line, label, match }] for every private-looking string below root. */
export function scan(root) {
  const findings = [];
  for (const file of walk(root)) {
    const buf = fs.readFileSync(path.join(root, file));
    if (buf.subarray(0, 8192).includes(0)) continue; // binary
    const lines = buf.toString('utf8').split('\n');
    lines.forEach((text, i) => {
      for (const [label, re, allow] of PATTERNS) {
        for (const m of text.matchAll(re)) if (!allow?.(m[0])) findings.push({ file, line: i + 1, label, match: m[0] });
      }
    });
  }
  return findings;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-hygiene-'));
// Negative samples are assembled at runtime so this file passes its own scan.
const HOME = '/Users/';
const LEAKS = [
  `see ${HOME}someone/x and ${'/home/'}someone/y`,
  `${'/private/tmp/claude-'}501/abc`,
  `mail someone@example${'.com'}`,
  `${'session_'}0123456789AbCdEf ${'cse_'}0123456789AbCdEf`,
  `9b2f1c3a-7d4e-4f6a-8b1c-${'2d3e4f5a6b7c'}`,
  `${'sk-ant'}-api03-xxxx`,
  `host my-mac${'.local'}`,
];
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('repository hygiene', () => {
  test('(+) the repository contains no private-looking strings', () => {
    const found = scan(REPO);
    assert.deepEqual(found, [], found.map((f) => `${f.file}:${f.line} ${f.label}: ${f.match}`).join('\n'));
  });

  test('(+) synthetic fixture ids pass, the scanner skips binaries and excluded dirs', () => {
    fs.mkdirSync(path.join(tmp, 'ok', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'ok', 'fixture.js'), [
      '11111111-1111-4111-8111-111111111111', 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd', 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0',
      'session_01AbCdEf cse_01Zz', '/private/tmp/claude-<uid>', '~/.config/nika', '.claude/settings.local.json', 'MacBook.local',
      'plugin@marketplace', 'https://claude.ai/code/session_[A-Za-z0-9]{1,64}', '/home/linuxbrew/.linuxbrew/bin/node',
    ].join('\n'));
    fs.writeFileSync(path.join(tmp, 'ok', 'node_modules', 'leak.js'), LEAKS[0]);
    fs.writeFileSync(path.join(tmp, 'ok', 'icon.png'), LEAKS[0]);
    fs.writeFileSync(path.join(tmp, 'ok', 'blob.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(LEAKS[0])]));
    assert.deepEqual(scan(path.join(tmp, 'ok')), []);
  });

  test('(−) home paths, scratchpad paths, emails, real-looking ids, keys and hosts are reported with file and line', () => {
    const dir = path.join(tmp, 'bad', 'src');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'leak.md'), LEAKS.join('\n'));
    const found = scan(path.join(tmp, 'bad'));
    assert.deepEqual(found.map((f) => [f.line, f.label]), [
      [1, 'home path'], [1, 'home path'], [2, 'claude scratchpad'], [3, 'email'], [4, 'session id'], [4, 'session id'],
      [5, 'uuid'], [6, 'api key'], [7, '.local host'],
    ]);
    assert.equal(found[0].file, path.join('src', 'leak.md'));
    assert.equal(found[0].match, `${HOME}someone`);
  });
});

describe('repository hygiene: the Linuxbrew prefix', () => {
  test('(−) only that exact prefix is allowed; any other folder under the home root is still reported', () => {
    const dir = path.join(tmp, 'brew');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.md'), [`${'/home/'}linuxbrew-evil/x`, `${'/home/'}linuxbre/x`, `${'/home/'}someone/.linuxbrew/bin/node`].join('\n'));
    assert.deepEqual(scan(dir).map((f) => f.match), [`${'/home/'}linuxbrew-evil`, `${'/home/'}linuxbre`, `${'/home/'}someone`]);
  });

  test('(−) a `..` segment after the prefix is reported, wherever it is; a longer name is not the prefix', () => {
    const dir = path.join(tmp, 'brew-dotdot');
    fs.mkdirSync(dir, { recursive: true });
    const H = '/home/';
    fs.writeFileSync(path.join(dir, 'a.md'), [
      `${H}linuxbrew/../someone/x`, // straight out of the prefix folder
      `${H}linuxbrew/.linuxbrew/../../someone/x`, // out of the prefix after it
      `${H}linuxbrew/.linuxbrew/bin/../../../someone/x`, // deeper
      `see ${H}linuxbrew/.linuxbrew/..`, // ends in ..
      `${H}linuxbrew/.linuxbrewx/bin/node`, // longer name
      `${H}linuxbrew/${H}someone/x`, // not the prefix, and a second home root inside the path is found on its own
    ].join('\n'));
    assert.deepEqual(scan(dir).map((f) => [f.line, f.match]), [
      [1, `${H}linuxbrew`],
      [2, `${H}linuxbrew`],
      [3, `${H}linuxbrew`],
      [4, `${H}linuxbrew`],
      [5, `${H}linuxbrew`],
      [6, `${H}linuxbrew`],
      [6, `${H}someone`],
    ]);
  });

  test('(+) the prefix with ordinary segments is allowed, also quoted or followed by punctuation; `..` inside a name is not a segment', () => {
    const dir = path.join(tmp, 'brew-ok');
    fs.mkdirSync(dir, { recursive: true });
    const H = '/home/';
    fs.writeFileSync(path.join(dir, 'a.md'), [
      `${H}linuxbrew/.linuxbrew`,
      `"${H}linuxbrew/.linuxbrew/bin/node",`,
      `(${H}linuxbrew/.linuxbrew/Cellar/node/22.1.0/bin/node)`,
      `\`${H}linuxbrew/.linuxbrew/bin/node\` first`,
      `${H}linuxbrew/.linuxbrew/a..b/node`,
    ].join('\n'));
    assert.deepEqual(scan(dir), []);
  });
});

describe('T17 no telemetry', () => {
  test('(+) src/ never opens a connection to anything but 127.0.0.1', () => {
    const offenders = [];
    for (const file of walk(path.join(REPO, 'src'))) {
      fs.readFileSync(path.join(REPO, 'src', file), 'utf8').split('\n').forEach((line, i) => {
        if (/from 'node:(https|net|dgram|tls)'/.test(line)) offenders.push(`${file}:${i + 1}`);
        if (/\bfetch\s*\(|https?\.(request|get)\s*\(/.test(line) && !line.includes("'127.0.0.1'")) offenders.push(`${file}:${i + 1}`);
      });
    }
    assert.deepEqual(offenders, []);
  });
});
