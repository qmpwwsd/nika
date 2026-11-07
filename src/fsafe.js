// Safe reads for files in directories agents can write to (review findings F1, F2):
// never follow a final symlink, never block on a FIFO, only regular files owned by this user, bounded reads.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fsSync.constants;
const FLAGS = O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
const UID = typeof process.getuid === 'function' ? process.getuid() : null;

function refuse(code, message) {
  return Object.assign(new Error(message), { code });
}

function checkStat(st) {
  if (!st.isFile()) throw refuse('ENOTREG', 'not a regular file');
  if (UID !== null && st.uid !== UID) throw refuse('EOWNER', 'not owned by this user');
  // a hard link gives an agent-writable name to a file it could not reach by path (verify N1)
  if (st.nlink !== 1) throw refuse('ENLINK', 'hard-linked file');
}

/** Opens a regular file owned by this user. Returns { handle, st }; the caller closes the handle. */
export async function openRegular(file) {
  const handle = await fs.open(file, FLAGS);
  try {
    const st = await handle.stat();
    checkStat(st);
    return { handle, st };
  } catch (err) {
    await handle.close();
    throw err;
  }
}

export async function readAt(handle, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead).toString('utf8');
}

/** First `max` bytes of a safe regular file as UTF-8; throws when the file is not safe to read. */
export async function readHead(file, max) {
  const { handle } = await openRegular(file);
  try {
    return await readAt(handle, 0, max);
  } finally {
    await handle.close();
  }
}

/** Synchronous variant for the git-dir walk; returns null instead of throwing. */
export function readHeadSync(file, max) {
  let fd;
  try {
    fd = fsSync.openSync(file, FLAGS);
    checkStat(fsSync.fstatSync(fd));
    const buf = Buffer.alloc(max);
    const n = fsSync.readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fsSync.closeSync(fd);
  }
}

/** True for a real directory (not a symlink to one). */
export async function isRealDir(p) {
  try {
    return (await fs.lstat(p)).isDirectory();
  } catch {
    return false;
  }
}
