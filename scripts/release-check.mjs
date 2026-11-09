#!/usr/bin/env node
// Release check, run by .github/workflows/release-linux.yml on a tag push before anything is built.
// Usage: node scripts/release-check.mjs <tag> [--root <repo>] [--notes <file>]
// Refuses (exit 1) unless the tag is vX.Y.Z, package.json, app/src-tauri/tauri.conf.json and app/src-tauri/Cargo.toml
// all carry one version (a drift between them is named first: the app-copy refresh compares the app's version with the
// CLI's) and it is X.Y.Z, and CHANGELOG.md has a non-empty "## X.Y.Z" section. That section, with its wrapped lines joined,
// becomes the draft release's notes: written to --notes, else printed. Bad usage exits 2. Node stdlib only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;

/** "v1.2.3" -> "1.2.3"; anything else throws. */
export function tagVersion(tag) {
  const m = TAG.exec(tag);
  if (!m) throw new Error(`tag ${JSON.stringify(tag)} is not vX.Y.Z`);
  return m[1];
}

/** The version in each file the release is built from, keyed by its repo-relative path. */
export function versionFiles(root) {
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const cargo = read('app/src-tauri/Cargo.toml');
  const pkgTable = /^\[package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(cargo);
  const cargoVersion = pkgTable && /^version\s*=\s*"([^"]*)"\s*$/m.exec(pkgTable[1]);
  return {
    'package.json': JSON.parse(read('package.json')).version,
    'app/src-tauri/tauri.conf.json': JSON.parse(read('app/src-tauri/tauri.conf.json')).version,
    'app/src-tauri/Cargo.toml': cargoVersion ? cargoVersion[1] : null,
  };
}

/** null when package.json, tauri.conf.json and Cargo.toml carry the same version, else every file with its version, listed. */
export function versionDrift(root) {
  const found = Object.entries(versionFiles(root));
  return new Set(found.map(([, v]) => v)).size > 1 ? found.map(([f, v]) => `${f} (${v})`).join(', ') : null;
}

/** Body of the "## <version>" section (heading excluded, up to the next "## " heading), trimmed; null if absent. */
export function changelogSection(text, version) {
  const heading = new RegExp(`^## ${version.replace(/\./g, '\\.')}(?=\\s|$)`);
  const lines = text.split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^#{1,2} /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

/**
 * Joins hard-wrapped lines: GitHub renders every newline of a release body as a line break, while CHANGELOG.md wraps
 * at about 120 characters. A line continues the one before unless it is blank, a list item (`- `, `* `, `+ `, `1. `),
 * a heading, a quote, a table row or a code fence; code blocks stay verbatim. Words and blank lines are unchanged.
 */
export function unwrapMarkdown(text) {
  const out = [];
  let fence = false;
  let joinable = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      out.push(line);
      joinable = false;
      continue;
    }
    if (fence) {
      out.push(line);
      continue;
    }
    const t = line.trim();
    const startsBlock = t === '' || /^([-*+] |\d+\. |#{1,6} |> |\|)/.test(t);
    if (!startsBlock && joinable) {
      out[out.length - 1] += ` ${t}`;
      continue;
    }
    out.push(line);
    joinable = t !== '' && !/^(#{1,6} |> |\|)/.test(t);
  }
  return out.join('\n');
}

/** Throws with a readable reason unless the tag can be released; returns the release notes (unwrapped). */
export function releaseCheck(root, tag) {
  const version = tagVersion(tag);
  const drift = versionDrift(root);
  if (drift) throw new Error(`version files differ: ${drift}`);
  const wrong = Object.entries(versionFiles(root)).filter(([, v]) => v !== version);
  if (wrong.length) {
    throw new Error(`${tag} does not match ${wrong.map(([f, v]) => `${f} (${v})`).join(', ')}`);
  }
  const notes = changelogSection(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version);
  if (notes === null) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
  if (notes === '') throw new Error(`the "## ${version}" section of CHANGELOG.md is empty`);
  return unwrapMarkdown(notes);
}

function main(argv) {
  let tag;
  let root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  let notesFile;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--root' || a === '--notes') && i + 1 < argv.length) {
      if (a === '--root') root = argv[++i];
      else notesFile = argv[++i];
    } else if (!a.startsWith('--') && tag === undefined) {
      tag = a;
    } else {
      return usage(`unexpected argument ${JSON.stringify(a)}`);
    }
  }
  if (tag === undefined) return usage('missing <tag>');
  let notes;
  try {
    notes = releaseCheck(root, tag);
  } catch (err) {
    process.stderr.write(`release-check: ${err.message}\n`);
    return 1;
  }
  if (notesFile) fs.writeFileSync(notesFile, `${notes}\n`);
  else process.stdout.write(`${notes}\n`);
  process.stderr.write(`release-check: ${tag} ok\n`);
  return 0;
}

function usage(reason) {
  process.stderr.write(`release-check: ${reason}\nusage: node scripts/release-check.mjs <tag> [--root <repo>] [--notes <file>]\n`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
