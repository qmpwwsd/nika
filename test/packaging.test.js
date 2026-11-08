// Linux desktop entries shipped by the bundler. appimagetool refuses a desktop file without a Categories entry
// (0.2.0's first release build failed there), and gtk-launch needs the visible io.github.qmpwwsd.nika entry.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAURI = path.join(ROOT, 'app', 'src-tauri');
const REQUIRED = ['Type', 'Name', 'Exec', 'Icon', 'Categories'];

/** Keys of the [Desktop Entry] group; returns the list of problems (empty when the entry is usable). */
function desktopProblems(text) {
  const lines = text.split('\n').map((l) => l.trim());
  if (lines[0] !== '[Desktop Entry]') return ['first line is not [Desktop Entry]'];
  const keys = new Map();
  for (const line of lines.slice(1)) {
    if (line.startsWith('[')) break;
    const eq = line.indexOf('=');
    if (eq > 0) keys.set(line.slice(0, eq), line.slice(eq + 1));
  }
  const problems = REQUIRED.filter((k) => !keys.get(k)).map((k) => `missing ${k}`);
  const cats = keys.get('Categories');
  if (cats && !/^([A-Za-z0-9-]+;)+$/.test(cats)) problems.push('Categories must be a ;-terminated list');
  return problems;
}

describe('Linux desktop entries', () => {
  const conf = JSON.parse(fs.readFileSync(path.join(TAURI, 'tauri.conf.json'), 'utf8'));
  const deb = conf.bundle.linux.deb;

  test('(+) the bundler template and the visible entry are complete; only the template is hidden', () => {
    const template = fs.readFileSync(path.join(TAURI, deb.desktopTemplate), 'utf8');
    assert.deepEqual(desktopProblems(template), []);
    assert.match(template, /^NoDisplay=true$/m);

    const visibleTarget = '/usr/share/applications/io.github.qmpwwsd.nika.desktop';
    assert.ok(deb.files[visibleTarget], 'the deb installs the visible entry');
    const visible = fs.readFileSync(path.join(TAURI, deb.files[visibleTarget]), 'utf8');
    assert.deepEqual(desktopProblems(visible), []);
    assert.doesNotMatch(visible, /^NoDisplay=/m);
  });

  test('(−) an entry without Categories, or with a malformed list, is reported', () => {
    const base = '[Desktop Entry]\nType=Application\nName=n\nExec=e\nIcon=i\n';
    assert.deepEqual(desktopProblems(base), ['missing Categories']);
    assert.deepEqual(desktopProblems(`${base}Categories=Development`), ['Categories must be a ;-terminated list']);
    assert.deepEqual(desktopProblems('Type=Application\n'), ['first line is not [Desktop Entry]']);
  });
});
