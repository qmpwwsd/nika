// Safe writes for the app tier (T8, T15): every target directory is a real, user-owned, non-world-writable directory;
// every target is absent or a regular user-owned file with one link; content goes to an O_EXCL temp file in the same
// directory, is fsynced, then renamed over the target. Stat checks come from src/fsafe.js.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openRegular, isRealDir } from './fsafe.js';

const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fsSync.constants;
const UID = typeof process.getuid === 'function' ? process.getuid() : null;
const GID = typeof process.getgid === 'function' ? process.getgid() : null;
const BACKUP_MAX = 1024 * 1024;
const NAME = /^[^/\0]{1,255}$/;
// The backup folder names src/rules.js writes: `YYYYMMDDTHHMMSSZ`, plus `-<n>` for a second backup in the same second.
const BACKUP_STAMP = /^(\d{8}T\d{6}Z)(?:-(\d{1,2}))?$/;

function refuse(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * lstat-based: a real directory owned by this user that group/other cannot write. `project: true` (a folder of the
 * user's repository, ADR 0006) never accepts world-writable, and accepts group-writable only on Linux when the folder's
 * group is the user's primary group (the per-user group of a 002 umask). `platform` and `gid` are injectable for tests.
 */
async function checkDir(dir, { project = false, platform = process.platform, gid = GID } = {}) {
  const st = await fs.lstat(dir);
  if (st.isSymbolicLink()) throw refuse('ESYMLINK', `${dir} is a symlink`);
  if (!st.isDirectory()) throw refuse('ENOTDIR', `${dir} is not a directory`);
  if (UID !== null && st.uid !== UID) throw refuse('EOWNER', `${dir} is not owned by this user`);
  if (st.mode & 0o002) throw refuse('EMODE', `${dir} is world-writable`);
  if (st.mode & 0o020 && !(project && platform === 'linux' && gid !== null && st.gid === gid)) {
    throw refuse('EMODE', `${dir} is group-writable`);
  }
  return dir;
}

/** Creates `dir` (0700 by default) if missing, then checks it is safe to write into. `opts`: { project, platform, gid }. */
export async function ensureDir(dir, mode = 0o700, opts = {}) {
  await fs.mkdir(dir, { recursive: true, mode });
  return checkDir(dir, opts);
}

/** Target must be absent or a regular, user-owned, single-link file (fsafe checks). */
async function checkTarget(target) {
  try {
    const { handle } = await openRegular(target);
    await handle.close();
  } catch (err) {
    if (err.code === 'ENOENT') return;
    if (err.code === 'ELOOP') throw refuse('ESYMLINK', `${target} is a symlink`);
    throw err;
  }
}

/**
 * Atomically writes `content` to `dir/name` with `mode`; returns the target path. `project: true` as in ensureDir.
 * `root` (a project folder): after the rename the write is verified with verifyInside (F6).
 */
export async function writeAtomic(dir, name, content, { mode = 0o600, project, platform, gid, root } = {}) {
  if (!NAME.test(name) || name === '.' || name === '..') throw refuse('EPATH', 'invalid file name');
  await checkDir(dir, { project, platform, gid });
  const target = path.join(dir, name);
  await checkTarget(target);
  const tmp = path.join(dir, `.${name}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode);
  try {
    await handle.chmod(mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    await fs.rename(tmp, target);
  } catch (err) {
    await handle.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
  if (root) await verifyInside(root, target);
  return target;
}

/**
 * Post-write check (F6): the directories from `root` down to `target` are still real directories (lstat, no symlink) and
 * `realpath(target)` is inside `root`. A directory swapped for a symlink after the checks and before the rename leaves the
 * file outside the project: it is unlinked and the write refused (`ESYMLINK`). A window remains between this check and
 * the end of the call (docs/security.md T8); the swap needs write access to the project folder.
 */
export async function verifyInside(root, target) {
  try {
    const rootReal = await fs.realpath(root);
    let dir = root;
    for (const seg of ['', ...path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean)]) {
      dir = path.join(dir, seg);
      const st = await fs.lstat(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw refuse('ESYMLINK', `${dir} is no longer a real directory`);
    }
    const real = await fs.realpath(target);
    if (!real.startsWith(rootReal + path.sep)) throw refuse('ESYMLINK', `${target} resolves outside the project folder`);
  } catch (err) {
    await fs.unlink(target).catch(() => {});
    throw err;
  }
}

/**
 * Validates `relPath` below `root` (an existing real dir): no absolute path, no `..`, `.` or empty segments, and every
 * intermediate component absent or a real directory. Returns { dir, name, abs } for ensureDir/writeAtomic.
 */
export async function checkComponents(root, relPath) {
  if (!(await isRealDir(root))) throw refuse('EPATH', `${root} is not a real directory`);
  if (typeof relPath !== 'string' || path.isAbsolute(relPath)) throw refuse('EPATH', 'path must be relative');
  const segs = relPath.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..' || s.includes('\0'))) throw refuse('EPATH', `invalid path ${relPath}`);
  let dir = root;
  for (const seg of segs.slice(0, -1)) {
    dir = path.join(dir, seg);
    let st;
    try {
      st = await fs.lstat(dir);
    } catch (err) {
      if (err.code === 'ENOENT') break; // the rest will be created
      throw err;
    }
    if (st.isSymbolicLink()) throw refuse('ESYMLINK', `${dir} is a symlink`);
    if (!st.isDirectory()) throw refuse('ENOTDIR', `${dir} is not a directory`);
  }
  return { dir: path.join(root, path.dirname(relPath)), name: path.basename(relPath), abs: path.join(root, relPath) };
}

/**
 * Copies the file at `srcAbs` (if any) to `backupRootAbs/relPath` before it is overwritten.
 * Returns the backup path, or null when there was nothing to back up.
 */
export async function backupFile(srcAbs, backupRootAbs, relPath) {
  let opened;
  try {
    opened = await openRegular(srcAbs);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let content;
  try {
    if (opened.st.size > BACKUP_MAX) throw refuse('EFBIG', `${srcAbs} is larger than ${BACKUP_MAX} bytes`);
    content = await opened.handle.readFile();
  } finally {
    await opened.handle.close();
  }
  await ensureDir(backupRootAbs);
  const { dir, name } = await checkComponents(backupRootAbs, relPath);
  await ensureDir(dir);
  return writeAtomic(dir, name, content);
}

/**
 * Keeps the newest `keep` backup folders in `root` (`backups/<key>/`) and removes the older ones; `current` is never
 * removed. Only entries named like a stamp nika wrote that lstat as real directories owned by this user count or go:
 * a symlink, a regular file or any other name is never followed, counted or deleted. Returns the removed names.
 */
export async function pruneBackups(root, keep, current = null) {
  try {
    await checkDir(root);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const stamps = [];
  for (const name of await fs.readdir(root)) {
    const m = BACKUP_STAMP.exec(name);
    const st = m ? await fs.lstat(path.join(root, name)).catch(() => null) : null;
    if (st?.isDirectory() && (UID === null || st.uid === UID)) stamps.push({ name, at: m[1], n: Number(m[2] ?? 0) });
  }
  stamps.sort((a, b) => (a.at === b.at ? a.n - b.n : a.at < b.at ? -1 : 1)); // oldest first
  const removed = [];
  for (const { name } of stamps.slice(0, Math.max(0, stamps.length - keep))) {
    if (name === current) continue;
    await fs.rm(path.join(root, name), { recursive: true, force: true }); // rm unlinks a symlink it meets, never follows it
    removed.push(name);
  }
  return removed;
}
