// Clear errors for a missing or too-old Node.js (0.3.2): the guard at the top of bin/nika, and the desktop app's
// error page for the `node-old` reason. The Rust side (where the shell looks for node) is tested in app/src-tauri.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = fs.readFileSync(path.join(ROOT, 'bin', 'nika'), 'utf8');
const ERROR_JS = fs.readFileSync(path.join(ROOT, 'app', 'src-tauri', 'ui', 'error.js'), 'utf8');

describe('bin/nika Node.js version guard', () => {
  // The guard is everything before the first dynamic import: that is the part an old Node.js must still parse and run.
  const cut = BIN.indexOf("import('");
  const guard = BIN.slice(0, cut);

  /** Runs the guard against a stub `process`. `exit` throws a marker so code after it does not run, like the real one. */
  function runGuard(version) {
    const out = { stderr: '', stdout: '', exitCode: undefined, exited: false };
    const proc = {
      version,
      versions: { node: version.replace(/^v/, '') },
      stderr: { write: (s) => { out.stderr += s; } },
      stdout: { write: (s) => { out.stdout += s; } },
      exit: (c) => { out.exitCode = c; out.exited = true; throw new Error('exit'); },
      set exitCode(c) { out.exitCode = c; },
      get exitCode() { return out.exitCode; },
    };
    try {
      vm.runInNewContext(guard, { process: proc });
    } catch (e) {
      if (e.message !== 'exit') throw e;
    }
    return out;
  }

  test('(+) the guard sits before the import, and the import is still there', () => {
    assert.ok(cut > 0, 'bin/nika imports src/cli.js after the guard');
    assert.match(BIN.slice(cut), /^import\('\.\.\/src\/cli\.js'\)/);
  });

  test('(+) Node.js older than 22 gets the exact message and hint on stderr, exit code 1, nothing on stdout', () => {
    for (const v of ['v12.22.9', 'v16.20.2', 'v18.19.1', 'v20.11.1', 'v21.7.3', 'v8.0.0', 'v9.11.2', 'v21.99.99']) {
      const r = runGuard(v);
      assert.equal(r.stderr, `nika: needs Node.js 22 or newer; this is ${v}.\nInstall a newer Node.js (macOS: brew upgrade node; Linux: see the README), then run nika again.\n`, v);
      assert.equal(r.stdout, '', v);
      assert.equal(r.exitCode, 1, v);
    }
  });

  test('(−) Node.js 22 or newer: no output at all, no exit, the import is reached', () => {
    for (const v of ['v22.0.0', 'v22.12.0', 'v23.1.0', 'v24.0.0', 'v25.8.1', 'v100.0.0']) {
      const r = runGuard(v);
      assert.deepEqual(r, { stderr: '', stdout: '', exitCode: undefined, exited: false }, v);
    }
  });

  test('(−) a version string the guard cannot read is treated as too old, not as fine', () => {
    for (const v of ['', 'vx', 'garbage']) {
      const r = runGuard(v);
      assert.equal(r.exitCode, 1, JSON.stringify(v));
      assert.match(r.stderr, /^nika: needs Node\.js 22 or newer; this is /);
    }
  });

  test('(−) the guard uses only syntax every Node.js version parses: no ?. ?? => let const class async await template strings', () => {
    const src = guard.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /\?\.|\?\?|=>|`|\b(?:let|const|class|async|await|import|export)\b/);
    // an old parser reads the whole file before it runs any of it: the launcher after the guard has no ?. or ?? either
    const launcher = BIN.slice(cut).replace(/^\s*\/\/.*$/gm, '');
    assert.ok(launcher.startsWith("import('"), 'the slice is the launcher');
    assert.doesNotMatch(launcher, /\?\.|\?\?/);
  });

  test('(+) bin/package.json makes the extensionless launcher CommonJS on every Node.js: exactly {"type": "commonjs"}', () => {
    // Without it the launcher inherits "type": "module" from the root package.json, and some Node.js versions (for
    // example 20.9) refuse an extensionless file in a module scope before the guard can print anything.
    const raw = fs.readFileSync(path.join(ROOT, 'bin', 'package.json'), 'utf8');
    assert.equal(raw, '{ "type": "commonjs" }\n');
    assert.deepEqual(JSON.parse(raw), { type: 'commonjs' });
    const root = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(root.type, 'module', 'the rest of the package stays ES modules');
    assert.ok(root.files.includes('bin/'), 'the whole bin/ folder ships, so bin/package.json does too');
  });

  test('(−) the launcher and its guard parse as a CommonJS script (no import/export statements, dynamic import() only)', () => {
    const noShebang = BIN.replace(/^#!.*\n/, '');
    assert.doesNotThrow(() => new vm.Script(noShebang), 'whole file');
    assert.doesNotThrow(() => new vm.Script(guard.replace(/^#!.*\n/, '')), 'guard alone');
    assert.doesNotMatch(noShebang.replace(/\/\/.*$/gm, ''), /^\s*(?:import|export)\b(?!\s*\()/m);
  });

  test('(+) the real launcher still prints the version on this Node.js (the guard lets 22+ through)', async () => {
    const { execFile } = await import('node:child_process');
    const r = await new Promise((resolve) => execFile(process.execPath, [path.join(ROOT, 'bin', 'nika'), '--version'], { env: { PATH: '/nonexistent' } }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
    assert.equal(r.err, null);
    assert.equal(r.stderr, '');
    assert.match(r.stdout, /^nika \d+\.\d+\.\d+\n$/);
  });
});

describe('desktop error page: node-old', () => {
  const TITLE = 'Node.js is too old';
  const body = (what) => `nika found ${what}, but needs 22 or newer. Install a newer Node.js (for example with Homebrew: brew upgrade node, or a version manager such as nvm), then retry.`;

  /** Runs ui/error.js against stubs of the page; returns what it wrote. */
  function page(search) {
    const els = { title: { textContent: '', focused: false, focus() { this.focused = true; } }, body: { textContent: '' } };
    const doc = { title: '', getElementById: (id) => els[id] };
    vm.runInNewContext(ERROR_JS, { location: { search }, document: doc, URLSearchParams });
    return { title: els.title.textContent, body: els.body.textContent, docTitle: doc.title, focused: els.title.focused };
  }

  test('(+) a valid version is shown, through textContent, with the exact title and body', () => {
    const r = page('?reason=node-old&node=v20.11.1');
    assert.equal(r.title, TITLE);
    assert.equal(r.body, body('Node.js v20.11.1'));
    assert.equal(r.docTitle, `${TITLE} · nika`);
    assert.equal(r.focused, true);
    assert.equal(page('?reason=node-old&node=v8.0.0').body, body('Node.js v8.0.0'));
    assert.equal(page('?reason=node-old&node=v999.999.999').body, body('Node.js v999.999.999'));
    assert.doesNotMatch(ERROR_JS, new RegExp('inner' + 'HTML|insertAdjacent|document\\.write'));
  });

  test('(−) no version, or one that does not match v<1-3 digits>.<1-3>.<1-3> exactly, is left out: "an old Node.js"', () => {
    const generic = body('an old Node.js');
    const bad = ['', 'v20.11', 'v20', '20.11.1', 'V20.11.1', 'v1000.0.0', 'v20.11.1000', 'v20.11.1-rc.1', 'v20.11.1 ', ' v20.11.1', 'v20.11.1\n', 'v20.11.1<img src=x>', '<b>v20.11.1</b>', 'v20.11.1%0A', 'v-1.0.0', 'v20..1', 'vx.y.z', 'v２０.1.1', 'null', 'undefined'];
    for (const v of bad) {
      const r = page(`?reason=node-old&node=${encodeURIComponent(v)}`);
      assert.equal(r.title, TITLE, v);
      assert.equal(r.body, generic, JSON.stringify(v));
    }
    assert.equal(page('?reason=node-old').body, generic);
    // a repeated node= takes the first, and it is checked like any other
    assert.equal(page('?reason=node-old&node=%3Cb%3E&node=v20.1.1').body, generic);
  });

  test('(−) the version is shown for node-old only; other reasons and unknown ones keep their text', () => {
    assert.equal(page('?reason=node-missing&node=v20.11.1').body.includes('v20.11.1'), false);
    assert.equal(page('?reason=stopped&node=v20.11.1').title, 'nika stopped');
    assert.equal(page('?reason=nope&node=v20.11.1').title, 'nika could not start');
    assert.equal(page('?node=v20.11.1').title, 'nika could not start');
    assert.equal(page('?reason=node-missing').title, 'Node.js was not found');
  });
});

describe('README requirements and install hints', () => {
  const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const line = README.split('\n').find((l) => l.startsWith('**Requirements:**')) ?? '';
  const install = README.indexOf('\n### Install\n');

  test('(+) a Requirements line before the install steps names Node.js 22+, tmux and Claude Code, and the AppImage caveat', () => {
    assert.ok(line, 'a **Requirements:** line exists');
    assert.ok(README.indexOf(line) < install, 'it comes before the Install steps');
    assert.match(line, /Node\.js 22 or newer/);
    assert.match(line, /tmux/);
    assert.match(line, /Claude Code \(`claude`\)/);
    assert.match(line, /AppImage cannot declare dependencies/);
  });

  test('(+) the Linux text says how to get Node.js 22 and that the app finds the version managers; NIKA_NODE for the rest', () => {
    const linux = README.slice(install, README.indexOf('\n### Build from source: macOS'));
    assert.match(linux, /NodeSource/);
    for (const m of ['nvm', 'fnm', 'Volta', 'mise', 'asdf']) assert.match(linux, new RegExp(m), m);
    assert.match(linux, /`NIKA_NODE`/);
  });

  test('(−) the README never tells anyone to install the distribution nodejs package', () => {
    assert.doesNotMatch(README, /apt(?:-get)? install[^\n]*\bnodejs\b/);
  });
});

describe('docs describe the node probe as it is', () => {
  const read = (...f) => fs.readFileSync(path.join(ROOT, ...f), 'utf8');
  const DOCS = { rules: read('rules', 'project-rules.md'), security: read('docs', 'security.md'), packaging: read('docs', 'packaging.md'), architecture: read('docs', 'architecture.md'), contract: read('docs', 'contracts', 'api-app.md') };

  test('(+) rule 13 and the security threat row say: cleared env except HOME, 2 s each, 6 s in total', () => {
    assert.match(DOCS.rules, /`node --version` with a fixed argv, a cleared env except `HOME`[\s\S]*?no shell[\s\S]*?a 2 s limit, at most 6 s in total across candidates/);
    assert.match(DOCS.security, /a cleared environment except `HOME`[^|]*a 2 s limit and 6 s in total across candidates \(spawn and read included; the kill after a timeout comes on top/);
    for (const k of ['packaging', 'architecture', 'contract']) assert.match(DOCS[k], /environment of\s+`HOME` alone/, k);
  });

  test('(−) no document still calls the probe environment empty', () => {
    for (const [k, text] of Object.entries(DOCS)) assert.doesNotMatch(text, /empty environment/, k);
    assert.doesNotMatch(DOCS.rules, /node --version` with a fixed argv, a cleared env, no shell/);
  });
});

describe('docs list the node candidates as the code does (0.3.2 fix round 2)', () => {
  const read = (...f) => fs.readFileSync(path.join(ROOT, ...f), 'utf8');
  const security = read('docs', 'security.md');
  const row = (id) => security.split('\n').find((l) => l.startsWith(`| ${id} |`)) ?? '';

  test('(+) README, rule 13, packaging, security and the contract name Linuxbrew for Linux', () => {
    for (const [name, text] of Object.entries({ readme: read('README.md'), rules: read('rules', 'project-rules.md'), packaging: read('docs', 'packaging.md'), security: row('T34'), contract: read('docs', 'contracts', 'api-app.md') })) {
      assert.match(text, /[Ll]inuxbrew/, name);
    }
    assert.match(read('docs', 'packaging.md'), /on Linux\s+`\/home\/linuxbrew\/\.linuxbrew\/bin\/node`/);
  });

  test('(+) the macOS fnm folder is documented as macOS only', () => {
    assert.match(read('docs', 'packaging.md'), /on macOS only also under\s+`~\/Library\/Application Support\/fnm`/);
    assert.match(read('rules', 'project-rules.md'), /fnm \(also under `~\/Library\/Application Support` on macOS\)/);
  });

  test('(+) the node probe has its own threat row (T34: worker thread, process group, kill), and T6 (tmux) no longer carries it', () => {
    assert.match(row('T34'), /worker thread/);
    assert.match(row('T34'), /own process group/);
    assert.match(row('T34'), /\/bin\/kill -KILL -- -<pgid>/);
    assert.doesNotMatch(row('T6'), /node --version|candidate `node`/);
  });

  test('(−) the launcher claim names the versions it was checked on instead of "every Node.js version"', () => {
    for (const f of [['CHANGELOG.md'], ['docs', 'packaging.md']]) {
      const text = read(...f);
      assert.doesNotMatch(text, /every Node\.js version/i, f.join('/'));
      assert.match(text, /10, 12, 18, 20\.9 and 20\.20/, f.join('/'));
    }
  });
});

describe('the node lookup stays off the main thread (source pins for what a unit test cannot reach)', () => {
  const LIB = fs.readFileSync(path.join(ROOT, 'app', 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const fnBody = (head) => {
    const at = LIB.indexOf(head);
    assert.ok(at >= 0, `${head} exists`);
    return LIB.slice(at, LIB.indexOf('\n}\n', at) + 3);
  };

  test('(+) start_server hands the lookup to a worker (in_background) and continue_start re-checks the generation first', () => {
    const start = fnBody('fn start_server(');
    assert.match(start, /child::in_background\(\s*\|\| child::find_node_here\(/);
    assert.match(start, /on_main\(&app, move \|a\| continue_start\(a, gen, root, found\)\)/);
    assert.match(fnBody('fn continue_start('), /^[^\n]*\n\s*\{\s*let i = shell\(app\)\.lock\(\);\s*if !applies\(i\.gen, i\.failed, i\.quitting, gen\) \{\s*return;/);
    assert.match(fnBody('fn handle('), /if !applies\(i\.gen, i\.failed, i\.quitting, gen\)/);
  });

  test('(+) a lookup that panics (no answer) ends on the start-failed page, and every exit path ends the running probe', () => {
    assert.match(fnBody('fn continue_start('), /found: Option<NodeLookup>/);
    assert.match(fnBody('fn continue_start('), /nav::node_or_reason\(found\)/);
    // quit() and RunEvent::Exit both go through stop_server, whose first act is to end the probe (and stop any further one)
    assert.match(fnBody('fn stop_server('), /^[^\n]*\n\s*child::kill_active_probe\(\);\s*let server/);
    assert.match(fnBody('fn quit('), /stop_server\(&app\);\s*app\.exit\(0\);/);
    assert.match(LIB, /RunEvent::Exit => stop_server\(app\)/);
  });

  test('(+) child.rs: the process-wide probe list is the one Quit stops and the one every real probe is registered in', () => {
    const CHILD = fs.readFileSync(path.join(ROOT, 'app', 'src-tauri', 'src', 'child.rs'), 'utf8');
    assert.match(CHILD, /pub fn kill_active_probe\(\) \{\s*PROBES\.stop\(\);\s*\}/);
    assert.match(CHILD, /pub fn run_node_version\([^)]*\) -> Option<String> \{\s*run_node_version_in\(&PROBES, /);
    assert.equal([...CHILD.matchAll(/run_node_version_in\(&PROBES/g)].length, 1, 'no other caller picks another list');
    assert.match(CHILD, /std::panic::catch_unwind\(std::panic::AssertUnwindSafe\(work\)\)\.ok\(\)/);
  });

  test('(−) kill_active_probe is called from stop_server only: Retry and failures must never stop probing for good', () => {
    assert.equal([...LIB.matchAll(/kill_active_probe\(\)/g)].length, 1);
    assert.equal([...LIB.matchAll(/stop_server\(/g)].length, 3, 'its definition, quit() and RunEvent::Exit');
    assert.doesNotMatch(fnBody('fn retry('), /stop_server|kill_active_probe/);
  });

  test('(−) nothing else in the shell calls the lookup, and start_server itself never runs it inline', () => {
    assert.equal([...LIB.matchAll(/find_node_here\(/g)].length, 1, 'one call site, the worker');
    assert.doesNotMatch(fnBody('fn start_server(').replace(/child::in_background\([\s\S]*?\n    \);/, ''), /find_node_here/);
  });
});

describe('docs match the code (0.3.2 fix round 3)', () => {
  const read = (...f) => fs.readFileSync(path.join(ROOT, ...f), 'utf8');
  const security = read('docs', 'security.md');
  const t34 = security.split('\n').find((l) => l.startsWith('| T34 |')) ?? '';
  // the candidates in the order the code tries them (child.rs node_candidates), each as the text a doc uses for it
  const ORDER = ['Homebrew', '/usr/local/bin', 'Linuxbrew', '~/.local/bin', 'Volta', 'mise', 'fnm', 'nvm', 'asdf', '/usr/bin'];
  const inOrder = (text, label) => {
    let at = -1;
    for (const name of ORDER) {
      const next = text.indexOf(name, at + 1);
      assert.ok(next > at, `${label}: ${name} comes after the previous one`);
      at = next;
    }
  };

  test('(+) the README Linux paragraph and app/README list the candidates in the order the code tries them', () => {
    const readme = read('README.md');
    const from = readme.indexOf('The app finds\nNode.js in these places, in this order:');
    assert.ok(from > 0, 'the README says it is the search order');
    inOrder(readme.slice(from, readme.indexOf('NIKA_NODE', from)), 'README');
    const app = read('app', 'README.md');
    const at = app.indexOf('looked up in the');
    assert.ok(at > 0);
    inOrder(app.slice(at, app.indexOf('listed in `docs/packaging.md`', at)).replace('$HOME/.local/bin', '~/.local/bin'), 'app/README');
  });

  test('(−) no doc says the kill is inside the 6 s; the kill after a timeout is said to come on top', () => {
    for (const f of [['rules', 'project-rules.md'], ['docs', 'security.md'], ['docs', 'packaging.md'], ['CHANGELOG.md'], ['docs', 'architecture.md'], ['docs', 'contracts', 'api-app.md']]) {
      assert.doesNotMatch(read(...f), /spawn, read and kill included/, f.join('/'));
    }
    assert.match(read('rules', 'project-rules.md'), /spawn and read included, the kill after a timeout on top/);
    assert.match(t34, /spawn and read included; the kill after a timeout comes on top/);
    assert.match(read('docs', 'packaging.md'), /spawn and read included and the kill after a timeout on top/);
  });

  test('(+) the not-found text covers a node that exists but never answers', () => {
    assert.match(read('docs', 'packaging.md'), /exists or none answers, it says `Node\.js was not found`/);
    assert.match(read('docs', 'architecture.md'), /none exists or answers/);
  });

  test('(+) Quit ends the running probe: rule 13, T34, packaging and the changelog say so; T34 keeps the lingering-holder residual', () => {
    assert.match(read('rules', 'project-rules.md'), /so is the run still going when the app quits, and no further run starts then/);
    assert.match(t34, /still going when the app quits is killed the same way and reaped, and no further run starts/);
    assert.match(t34, /signals only while holding the same lock/);
    assert.match(read('docs', 'packaging.md'), /and so is the run still going when the app quits/);
    assert.match(read('CHANGELOG.md'), /so is one still running when you quit/);
    assert.match(t34, /Residual: a candidate that exits at once but leaves a background process holding its stdout is not killed/);
    assert.match(t34, /one reader thread of the shell stay/);
  });

  test('(+) a lookup that ends without an answer shows the start-failed page, and the docs say Retry works', () => {
    assert.match(t34, /a lookup that ends without an answer \(its thread panicked\) shows the start-failed page, so Retry works/);
    assert.match(read('rules', 'project-rules.md'), /a lookup that ends without an answer \(its thread panicked\) shows the start-failed page, so Retry works/);
  });
});
