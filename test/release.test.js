// scripts/release-check.mjs: the tag-triggered release workflow runs it before the build. It must refuse a tag that
// does not match every version file, and it must find the tag's CHANGELOG section, which becomes the draft's notes.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tagVersion, changelogSection, versionFiles, releaseCheck } from '../scripts/release-check.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'release-check.mjs');
const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

/** Top-level jobs of a workflow (two-space keys under `jobs:`), name -> text of the job. */
function jobBlocks(text) {
  const jobs = {};
  let current = null;
  let inJobs = false;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) { inJobs = line.startsWith('jobs:'); current = null; continue; }
    const key = inJobs && /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (key) { current = key[1]; jobs[current] = ''; continue; }
    if (current) jobs[current] += `${line}\n`;
  }
  return jobs;
}

/** Security rules for every workflow; returns the list of problems. */
function workflowProblems(source) {
  const text = source.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const problems = [];
  for (const m of text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
    if (!/^actions\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/.test(m[1])) problems.push(`not an official action pinned by SHA: ${m[1]}`);
  }
  const top = text.split(/^jobs:/m)[0];
  if (/:\s*write\b/.test(top)) problems.push('write access at workflow level');
  for (const [name, body] of Object.entries(jobBlocks(text))) {
    if (name !== 'draft-release' && /:\s*write\b/.test(body)) problems.push(`write access in job ${name}`);
    if (name === 'draft-release' && /uses:\s*actions\/checkout@/.test(body)) problems.push('draft-release checks out the repository');
  }
  return problems;
}

/** A synthetic repo with the four files the check reads. */
function fixture({ pkg = '1.2.3', conf = '1.2.3', cargo = '1.2.3', changelog } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-release-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'app', 'src-tauri'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: pkg }));
  fs.writeFileSync(path.join(dir, 'app', 'src-tauri', 'tauri.conf.json'), JSON.stringify({ version: conf }));
  fs.writeFileSync(path.join(dir, 'app', 'src-tauri', 'Cargo.toml'),
    `[package]\nname = "x"\nversion = "${cargo}"\n\n[dependencies]\nserde = { version = "=9.9.9" }\n`);
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog ?? '# Changelog\n\n## 1.2.3 — 2026-01-02\n\n- One change.\n\n## 1.2.2 — 2026-01-01\n\n- Older.\n');
  return dir;
}

describe('release check', () => {
  test('(+) this repository: the current version has matching files and a CHANGELOG section', () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const notes = releaseCheck(ROOT, `v${version}`);
    assert.ok(notes.length > 0);
    assert.doesNotMatch(notes, /^## /m, 'the notes stop before the next version heading');
  });

  test('(+) a synthetic repo: notes are the section body only, without its heading or the older version', () => {
    const dir = fixture();
    assert.equal(releaseCheck(dir, 'v1.2.3'), '- One change.');
    assert.deepEqual(versionFiles(dir), { 'package.json': '1.2.3', 'app/src-tauri/tauri.conf.json': '1.2.3', 'app/src-tauri/Cargo.toml': '1.2.3' });
  });

  test('(+) the CLI writes the notes file and exits 0', () => {
    const dir = fixture();
    const out = path.join(dir, 'notes.md');
    execFileSync(process.execPath, [SCRIPT, 'v1.2.3', '--root', dir, '--notes', out]);
    assert.equal(fs.readFileSync(out, 'utf8'), '- One change.\n');
  });

  test('(−) tag shapes other than vX.Y.Z are refused', () => {
    for (const tag of ['1.2.3', 'v1.2', 'v1.2.3-rc.1', 'v1.2.3 ', 'v01.2.3', 'release-1.2.3', '']) {
      assert.throws(() => tagVersion(tag), /tag/, JSON.stringify(tag));
    }
    assert.equal(tagVersion('v10.0.12'), '10.0.12');
  });

  test('(−) a version file that does not match the tag is named in the error', () => {
    assert.throws(() => releaseCheck(fixture({ conf: '1.2.4' }), 'v1.2.3'), /tauri\.conf\.json.*1\.2\.4/);
    assert.throws(() => releaseCheck(fixture({ cargo: '1.2.2' }), 'v1.2.3'), /Cargo\.toml.*1\.2\.2/);
    assert.throws(() => releaseCheck(fixture({ pkg: '1.2.4', conf: '1.2.4', cargo: '1.2.4' }), 'v1.2.3'), /package\.json/);
  });

  test('(−) a missing or empty CHANGELOG section is refused; a longer version never matches a shorter one', () => {
    assert.throws(() => releaseCheck(fixture({ changelog: '# Changelog\n\n## 1.2.2\n\n- Older.\n' }), 'v1.2.3'), /no "## 1\.2\.3" section/);
    assert.throws(() => releaseCheck(fixture({ changelog: '# Changelog\n\n## 1.2.3\n\n## 1.2.2\n\n- Older.\n' }), 'v1.2.3'), /empty/);
    assert.equal(changelogSection('## 1.2.30\n\n- Not this.\n\n## 1.2.3 — x\n\n- This.\n', '1.2.3'), '- This.');
    assert.equal(changelogSection('## 1.2.3-rc.1\n\n- Not this.\n', '1.2.3'), null);
  });

  test('(+) workflows: official actions pinned by SHA; only draft-release can write, runs no checkout, makes drafts', () => {
    const dir = path.join(ROOT, '.github', 'workflows');
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
      assert.deepEqual(workflowProblems(fs.readFileSync(path.join(dir, name), 'utf8')), [], name);
    }
    const jobs = jobBlocks(fs.readFileSync(path.join(dir, 'release-linux.yml'), 'utf8'));
    assert.match(jobs['draft-release'], /--draft/);
    assert.match(jobs['draft-release'], /if: github\.event_name == 'push'/);
  });

  test('(−) the workflow checker reports unpinned or third-party actions and write access outside draft-release', () => {
    const bad = [
      'permissions:', '  contents: read', 'jobs:',
      '  build:', '    permissions:', '      contents: write', '    steps:',
      '      - uses: actions/checkout@v4', '      - uses: someone/action@0123456789abcdef0123456789abcdef01234567',
      '  draft-release:', '    steps:', '      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567',
    ].join('\n');
    assert.deepEqual(workflowProblems(bad), [
      'not an official action pinned by SHA: actions/checkout@v4',
      'not an official action pinned by SHA: someone/action@0123456789abcdef0123456789abcdef01234567',
      'write access in job build',
      'draft-release checks out the repository',
    ]);
  });

  test('(−) the CLI exits 1 on a mismatch and 2 on bad usage, and writes no notes file', () => {
    const dir = fixture({ cargo: '0.0.1' });
    const out = path.join(dir, 'notes.md');
    const run = (args) => {
      try { execFileSync(process.execPath, [SCRIPT, ...args], { stdio: 'pipe' }); return 0; } catch (e) { return e.status; }
    };
    assert.equal(run(['v1.2.3', '--root', dir, '--notes', out]), 1);
    assert.equal(fs.existsSync(out), false);
    assert.equal(run([]), 2);
    assert.equal(run(['v1.2.3', '--bogus']), 2);
  });
});
