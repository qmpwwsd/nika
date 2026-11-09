// The copy of nika.app in ~/Applications (macOS, ADR 0011, contract §6 "App copy"). This is the one write path outside
// nika's own folders, so every step is defensive: the target is exactly <home>/Applications/nika.app, the source comes only
// from the running install (never from a request, an argument, an env var, the marker or any file's content), nothing
// is followed through a symlink, and a copy is built in a fresh temp folder and swapped in with rename.
// All fs and exec calls go through `deps` ({ fs, exec, uid, brewApps }) so tests never touch the real ~/Applications.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRegular, readAt, readHead } from './fsafe.js';
import { ensureDir, writeAtomic } from './fwrite.js';

export const APP_ID = 'io.github.qmpwwsd.nika';
export const BREW_APPS = ['/opt/homebrew/opt/nika/nika.app', '/usr/local/opt/nika/nika.app'];
export const DITTO = '/usr/bin/ditto';
export const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
/** Root of this install: the folder with bin/, src/ and package.json (a bundle's `Contents/Resources/nika`, a keg's `libexec`). */
export const INSTALL_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const UID = typeof process.getuid === 'function' ? process.getuid() : null;
const PLIST_MAX = 64 * 1024;
const MARKER = 'app-copy.json';
const MARKER_MAX = 4096;
const TMP_PREFIX = '.nika-copy-';
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,20})?$/;
const CODES = new Set(['unsupported', 'no-source', 'foreign-target', 'copy-busy', 'copy-failed']);
const fail = (code) => Object.assign(new Error(code), { code }); // the message is the code: no path or OS text reaches a caller

let installing = false; // one install at a time per process

export const targetPath = (home) => path.join(home, 'Applications', 'nika.app');

/** A real directory (lstat: a symlink is not one) owned by `uid`; `strict` also refuses group/other write (the parent folder). */
const ownDir = (st, uid, strict = false) => st.isDirectory() && (uid === null || st.uid === uid) && !(strict && st.mode & 0o022);

const plistString = (xml, key) => new RegExp(`<key>${key}</key>\\s*<string>([^<]{1,200})</string>`).exec(xml)?.[1] ?? null;

/**
 * { id, version } of the bundle at `dir`, or null. The bundle and its Contents folder must be real directories owned by the
 * user (lstat, never a symlink); Info.plist is read through fsafe (O_NOFOLLOW, regular file, at most 64 KB) and only the
 * bundle id and short version are taken from it (XML plists only). `version` is null unless it is a plain x.y.z.
 */
export async function readBundle(dir, deps = {}) {
  const { fs = fsp, uid = UID } = deps;
  let xml;
  try {
    for (const d of [dir, path.join(dir, 'Contents')]) if (!ownDir(await fs.lstat(d), uid)) return null;
    const { handle, st } = await openRegular(path.join(dir, 'Contents', 'Info.plist'));
    try {
      if (st.size > PLIST_MAX) return null;
      xml = await readAt(handle, 0, st.size);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  xml = xml.replace(/<!--[\s\S]*?-->/g, '');
  const id = plistString(xml, 'CFBundleIdentifier');
  if (!id) return null;
  const version = plistString(xml, 'CFBundleShortVersionString');
  return { id, version: version && VERSION.test(version) ? version : null };
}

/**
 * The nika.app to copy from, or null: the bundle this process runs from (root = <x>.app/Contents/Resources/nika), the keg
 * app next to this install (root = <keg>/libexec), then the fixed Homebrew paths. A candidate counts only as a real folder
 * with nika's bundle id and a plain version; the target itself is never a source.
 */
export async function findSource({ root, home }, deps = {}) {
  const target = targetPath(home);
  const r = path.resolve(root);
  const up = (n) => path.resolve(r, ...Array(n).fill('..'));
  const candidates = [];
  if (path.basename(r) === 'nika' && path.basename(up(1)) === 'Resources' && path.basename(up(2)) === 'Contents' && up(3).endsWith('.app')) candidates.push(up(3));
  if (path.basename(r) === 'libexec') candidates.push(path.join(up(1), 'nika.app'));
  candidates.push(...(deps.brewApps ?? BREW_APPS));
  for (const c of candidates) {
    if (c === target) continue;
    const b = await readBundle(c, deps);
    if (b?.id === APP_ID && b.version) return c;
  }
  return null;
}

/** The state marker { managed, version, dismissed }; anything unreadable, symlinked or mistyped reads as the defaults. */
async function readMarker(stateDir) {
  const none = { managed: false, version: null, dismissed: false };
  try {
    const j = JSON.parse(await readHead(path.join(stateDir, MARKER), MARKER_MAX));
    return { managed: j.managed === true, version: typeof j.version === 'string' && VERSION.test(j.version) ? j.version : null, dismissed: j.dismissed === true };
  } catch {
    return none;
  }
}

const writeMarker = async (stateDir, m) => {
  await ensureDir(stateDir);
  await writeAtomic(stateDir, MARKER, `${JSON.stringify({ managed: m.managed, version: m.version, dismissed: m.dismissed })}\n`);
};

/**
 * What is at ~/Applications/nika.app: { kind: 'absent', appsMissing } (nothing there, or no ~/Applications yet),
 * { kind: 'nika', version } or { kind: 'foreign' } (a symlink, a file, another owner, another bundle id, an unreadable
 * plist, or a ~/Applications that is not a plain folder you own).
 */
async function inspectTarget(home, deps) {
  const { fs = fsp, uid = UID } = deps;
  const apps = path.join(home, 'Applications');
  try {
    if (!ownDir(await fs.lstat(apps), uid, true)) return { kind: 'foreign' };
  } catch (err) {
    return err.code === 'ENOENT' ? { kind: 'absent', appsMissing: true } : { kind: 'foreign' };
  }
  try {
    await fs.lstat(targetPath(home));
  } catch (err) {
    return err.code === 'ENOENT' ? { kind: 'absent', appsMissing: false } : { kind: 'foreign' };
  }
  const b = await readBundle(targetPath(home), deps);
  return b?.id === APP_ID ? { kind: 'nika', version: b.version } : { kind: 'foreign' };
}

// shortcut: compared as strings, not realpaths; a HOME that is itself reached through a symlink reads as "not running from the copy"
const runningFrom = (root, home) => `${path.resolve(root)}${path.sep}`.startsWith(`${targetPath(home)}${path.sep}`);

/**
 * { state, managed, dismissed, version, available, running } (contract §3 `appCopy`). `state`: unsupported (not macOS) ·
 * foreign (the target path is not nika's) · no-source · missing · current (nika at the source's version) · stale.
 */
export async function appCopyState({ root, home, platform, stateDir }, deps = {}) {
  const base = { managed: false, dismissed: false, version: null, available: null, running: false };
  if (platform !== 'darwin') return { state: 'unsupported', ...base };
  const [marker, t, source] = await Promise.all([readMarker(stateDir), inspectTarget(home, deps), findSource({ root, home }, deps)]);
  const available = source ? (await readBundle(source, deps))?.version ?? null : null;
  const version = t.kind === 'nika' ? t.version : null;
  let state;
  if (t.kind === 'foreign') state = 'foreign';
  else if (!source) state = 'no-source';
  else if (t.kind === 'absent') state = 'missing';
  else state = version === available ? 'current' : 'stale';
  return { state, managed: marker.managed && t.kind === 'nika', dismissed: marker.dismissed, version, available, running: t.kind === 'nika' && runningFrom(root, home) };
}

/** Records "Not now" in the marker (managed and version are kept). Never touches ~/Applications. `deps` is unused: the marker goes through fsafe and fwrite. */
export async function dismissAppCopy({ stateDir }, deps = {}) {
  await writeMarker(stateDir, { ...(await readMarker(stateDir)), dismissed: true });
}

/**
 * Copies or updates the app: { state: 'current', version, restart, changed: 'added' | 'updated' | 'none', recorded }.
 * `recorded` is false when the marker could not be written (the copy is in place but nika will not refresh it later).
 * An explicit install over a current copy nika did not make copies nothing but records it as managed, so a later
 * `brew upgrade` reaches it (the launch commands never do this: refreshManagedCopy acts on managed copies only).
 * Throws an Error whose `code` (and message) is one of unsupported, no-source, foreign-target, copy-busy, copy-failed.
 */
export async function installAppCopy(args, deps = {}) {
  if (args.platform !== 'darwin') throw fail('unsupported');
  if (installing) throw fail('copy-busy');
  installing = true;
  try {
    return await doInstall(args, deps);
  } catch (err) {
    throw CODES.has(err?.code) && err.message === err.code ? err : fail('copy-failed');
  } finally {
    installing = false;
  }
}

async function doInstall({ root, home, stateDir }, deps) {
  const { fs = fsp, exec, uid = UID } = deps;
  const source = await findSource({ root, home }, deps);
  const src = source && (await readBundle(source, deps));
  if (!src?.version) throw fail('no-source');
  const apps = path.join(home, 'Applications');
  const target = targetPath(home);

  let t = await inspectTarget(home, deps);
  if (t.kind === 'foreign') throw fail('foreign-target');
  if (t.kind === 'nika' && t.version === src.version) {
    const marker = await readMarker(stateDir);
    // shortcut: a marker that cannot be written is reported (`recorded: false`), not fatal
    const recorded = marker.managed || (await writeMarker(stateDir, { managed: true, version: src.version, dismissed: marker.dismissed }).then(() => true, () => false));
    return { state: 'current', version: src.version, restart: false, changed: 'none', recorded };
  }
  if (t.appsMissing) {
    await fs.mkdir(apps, { mode: 0o700 });
    if ((await inspectTarget(home, deps)).kind !== 'absent') throw fail('foreign-target');
  }

  const tmp = await fs.mkdtemp(path.join(apps, TMP_PREFIX)); // 0700, a fresh name nobody else knows
  const made = await fs.lstat(tmp);
  // The temp folder is removed only by this exact path (made above), and fs.rm never follows a symlink it meets. Just before,
  // ~/Applications must still be a plain folder you own and the temp folder the very directory mkdtemp made (same device and
  // inode, not a symlink); if either changed, the folder is left where it is (the copy itself is already in place).
  const dropTmp = async () => {
    const still = await Promise.all([fs.lstat(apps), fs.lstat(tmp)]).then(([a, t2]) => ownDir(a, uid, true) && ownDir(t2, uid) && t2.dev === made.dev && t2.ino === made.ino, () => false);
    if (still) await fs.rm(tmp, { recursive: true, force: true });
  };
  let aside = null; // where the old copy sits while the new one is swapped in
  let changed;
  try {
    const fresh = path.join(tmp, 'nika.app');
    await exec(DITTO, [source, fresh]);
    const copy = await readBundle(fresh, deps);
    if (copy?.id !== APP_ID || copy.version !== src.version) throw fail('copy-failed');
    t = await inspectTarget(home, deps); // again right before the swap: it may have changed while ditto ran
    if (t.kind === 'foreign') throw fail('foreign-target');
    changed = t.kind === 'nika' ? 'updated' : 'added';
    if (t.kind === 'nika') {
      await fs.rename(target, path.join(tmp, 'previous.app'));
      aside = path.join(tmp, 'previous.app');
    }
    try {
      await fs.rename(fresh, target);
    } catch {
      if (aside) {
        await fs.rename(aside, target); // if even this fails, `aside` stays set and the temp folder keeps the old copy
        aside = null;
      }
      throw fail('copy-failed');
    }
  } catch (err) {
    if (aside === null) await dropTmp().catch(() => {});
    throw err;
  }
  await dropTmp().catch(() => {}); // holds only what nika made (the previous copy of itself)
  await exec(LSREGISTER, ['-f', target]).catch(() => {}); // so LaunchServices and Spotlight see it now; failure is harmless
  // shortcut: a marker that cannot be written is not worth failing a finished copy; it is reported (`recorded: false`) and the copy counts as not managed
  const recorded = await writeMarker(stateDir, { managed: true, version: src.version, dismissed: (await readMarker(stateDir)).dismissed }).then(() => true, () => false);
  return { state: 'current', version: src.version, restart: changed === 'updated' && runningFrom(root, home), changed, recorded };
}

/**
 * The launch commands' refresh (after `brew upgrade`): updates a copy nika made when it is stale and the source has this
 * CLI's `version`. Returns 'updated' or 'none'; never touches an unmanaged, foreign or missing copy. Throws as install does.
 */
export async function refreshManagedCopy({ version, ...args }, deps = {}) {
  if (args.platform !== 'darwin') return 'none';
  const s = await appCopyState(args, deps);
  if (!(s.managed && s.state === 'stale' && s.available === version)) return 'none';
  await installAppCopy(args, deps);
  return 'updated';
}
