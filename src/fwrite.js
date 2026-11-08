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

/** Atomically writes `content` to `dir/name` with `mode`; returns the target path. `project: true` as in ensureDir. */
export async function writeAtomic(dir, name, content, { mode = 0o600, project, platform, gid } = {}) {
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
  return target;
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
