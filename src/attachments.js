// The attachment store (0.5, W2, design-W2 section 3 and 4; rules constraints 5, 9, 10, 11): checks the bytes of an upload, writes them to
// `<state>/attachments/<key>/<id>.<ext>`, looks them up for a send, removes them and prunes old ones. The user's file name never reaches
// the disk (only an extension from a fixed list), the stored name is a random id nika made, nothing serves a file back, and nothing about
// a file (name, bytes, path, id) is ever logged. Writes go through src/fwrite.js, reads through src/fsafe.js. Keep this file ASCII.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { stateDir } from './paths.js';
import { ensureDir, writeAtomic, removeOwnFile, removeOwnDir } from './fwrite.js';
import { openRegular } from './fsafe.js';
import { loadConfig } from './store.js';
import { PANE_ID, PROJECT_KEY } from './ids.js';

export const UPLOAD_CAP = 12 * 1024 * 1024; // request body: base64 of 8 MiB is 11 184 812 chars plus the JSON frame
export const MAX_BYTES = 8 * 1024 * 1024; // decoded, per file
export const PER_MESSAGE = 6;
export const ID = /^[0-9a-f]{16}$/;
/** The full pasted path: one token for Claude, no space, quote, backslash, `@`, `!`, `#` or control (design 5.3). */
export const PATH_OK = /^\/[A-Za-z0-9._/+-]{1,200}$/;

const TOTAL_MAX = 256 * 1024 * 1024; // all projects together
const FILES_MAX = 500;
const EVICT_MIN_AGE = 60 * 60 * 1000; // a file that young may not be sent or read yet
const TMP_MAX_AGE = 60 * 60 * 1000; // a left-over writeAtomic temp file (a crash mid-write)
const PRUNE_EVERY = 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const UPLOADS_PER_MIN = 30;
const RECORDS_MAX = 500;
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'csv', 'tsv', 'log', 'xml', 'html', 'htm', 'css',
  'scss', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
  'php', 'sh', 'bash', 'zsh', 'sql', 'diff', 'patch',
]);
const FILE_NAME = new RegExp(`^[0-9a-f]{16}\\.(?:png|jpg|gif|webp|pdf|${[...TEXT_EXT].join('|')})$`);
const TMP_NAME = /^\.[0-9a-f]{16}\.[a-z0-9]{1,10}\.[0-9a-f]{12}\.tmp$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
// tab, LF and CR are text; the other C0 controls, DEL and the C1 range are not
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const UID = typeof process.getuid === 'function' ? process.getuid() : null;

/** `{ status, body: { error, message } }`; the message is the code in words and is never shown by the page. */
const fail = (status, error) => ({ status, body: { error, message: error.replace(/-/g, ' ') } });
const isMine = (st) => UID === null || st.uid === UID;
const isDiskFull = (err) => err?.code === 'ENOSPC' || err?.code === 'EDQUOT';
/** A node error code only, never the error object: its message could carry the state path. */
const codeOf = (err) => (/^[A-Z0-9_]{1,20}$/.test(err?.code) ? err.code : 'ERR');

/**
 * What the bytes are, from the magic at offset 0 (never from the name): `{ type, ext }` with type png|jpeg|gif|webp|pdf|text, or
 * `{ error: 'empty' }` / `{ error: 'wrong-type' }`. Text is strict UTF-8 without C0 controls (but tab, LF, CR), DEL and C1; its
 * extension is the name's, kept only when it is in TEXT_EXT, else `txt`. A PNG named `notes.txt` is stored as `.png`.
 */
export function sniff(buf, name) {
  if (!buf?.length) return { error: 'empty' };
  const head = buf.toString('latin1', 0, 12);
  if (buf.subarray(0, 8).equals(PNG)) return { type: 'png', ext: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: 'jpeg', ext: 'jpg' };
  if (/^GIF8[79]a/.test(head)) return { type: 'gif', ext: 'gif' };
  if (head.length === 12 && head.startsWith('RIFF') && head.slice(8) === 'WEBP') return { type: 'webp', ext: 'webp' };
  if (head.startsWith('%PDF-')) return { type: 'pdf', ext: 'pdf' };
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return { error: 'wrong-type' };
  }
  if (CONTROLS.test(text)) return { error: 'wrong-type' };
  const ext = /\.([A-Za-z0-9]{1,10})$/.exec(typeof name === 'string' ? name : '')?.[1].toLowerCase();
  return { type: 'text', ext: TEXT_EXT.has(ext) ? ext : 'txt' };
}

// A file nika never takes, whatever its bytes are (rule 4, the owner's "don't collect sensitive data"): by base name, any case, `.env`, `.env.*`,
// `.envrc`, `.envrc.*`, `*.key`, `*.pem`, the keystores `*.p12`, `*.pfx`, `*.jks` and `*.keystore`, the OpenVPN profiles `*.ovpn`, the credential files
// `.netrc`, `.git-credentials`, `.pgpass`, `.npmrc` and `credentials` (exact base names; owner decision 2026-11-16), and the SSH private keys by exact name
// (`id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519` and the FIDO forms `id_ecdsa_sk`, `id_ed25519_sk`; never their `.pub` files, never another name that only
// starts with `id_`). A name that only contains one of the exact names (`netrc`, `.netrc.bak`, `credentials.txt`, `my-credentials`) is not on the list.
// public/attach.js keeps a copy of this pattern (browser code cannot import it); a test pins that the two agree.
const SECRET_NAME = /^(?:\.env(?:\..*)?|\.envrc(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519|ecdsa_sk|ed25519_sk)|\.netrc|\.git-credentials|\.pgpass|\.npmrc|credentials|.*\.(?:key|pem|p12|pfx|jks|keystore|ovpn))$/is;
/** True for the name (or the last part of a path) of a credential file (`.env`, `.env.*`, `.envrc`, `.envrc.*`, `*.key`, `*.pem`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.ovpn`, `.netrc`, `.git-credentials`, `.pgpass`, `.npmrc`, `credentials`, an SSH private key), case-insensitive. */
export const isSecretName = (name) => typeof name === 'string' && SECRET_NAME.test(name.split(/[\\/]/).pop().trimEnd());

/** Step 1 of the upload: exactly `name` (a string, at most 255 UTF-16 units) and `data` (standard base64). null = fine, else the 400 (`secret-file` for a credential file's name). */
export function checkUploadBody(body) {
  const ok = body !== null && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).length === 2 && Object.hasOwn(body, 'name') && Object.hasOwn(body, 'data')
    && typeof body.name === 'string' && body.name.length <= 255
    && typeof body.data === 'string' && body.data.length % 4 === 0 && BASE64.test(body.data);
  if (!ok) return fail(400, 'invalid');
  return isSecretName(body.name) ? fail(400, 'secret-file') : null;
}

/**
 * `env` picks the state dir; `loadKeepDays()` (default: `attachments.keepDays` of config.json, read at every prune) gives the days a
 * file stays; `setTimer(fn, ms)` returns a handle and `clearTimer(handle)` stops it (default: setInterval/clearInterval); `log(line)`
 * receives `nika: attachments: <code>` lines only.
 */
export function createAttachments({
  env = process.env, now = Date.now, loadKeepDays = async () => (await loadConfig(env)).config.attachments.keepDays,
  setTimer = (fn, ms) => setInterval(fn, ms), clearTimer = clearInterval, log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const records = new Map(); // id -> { id, pane, key, path, type, size, at, sent }; only what this process issued, oldest dropped past RECORDS_MAX
  const stamps = []; // admission times of the last minute
  let inflight = false;
  let writing = null; // the key folder the one save in flight writes into: no prune (startup, timer or the save's own) removes it
  let timer = null;
  const note = (err) => log(`nika: attachments: ${codeOf(err)}`);
  const rootDir = () => path.join(stateDir(env), 'attachments');
  const unmoved = async (p) => (await fs.realpath(p)) === p; // no folder on the way became a link since nika made the path

  /**
   * Prune (design 4.4). Only names nika writes, in real user-owned key folders, as regular single-link files, are looked at, and every
   * removal goes through src/fwrite.js (removeOwnFile for a file, removeOwnDir for an emptied key folder), which follow nothing. The folder in `writing` is never removed.
   * Never throws; `full` = still over a cap for `need` more bytes (and one more file) after removing everything that may go;
   * `failed` = the caps could not be checked (an error at the top level, or a key folder that could not be listed): a save then refuses.
   */
  async function sweep(need = 0) {
    const out = { removed: 0, total: 0, full: false, failed: false };
    const root = rootDir();
    try {
      try {
        await fs.lstat(root);
      } catch (err) {
        if (err.code === 'ENOENT') return out;
        throw err;
      }
      await ensureDir(root); // a symlink, a foreign owner or a group/world-writable root is refused here
      const keepMs = (await loadKeepDays()) * DAY;
      const t = now();
      const drop = async (dir, name) => {
        try {
          if (!(await removeOwnFile(dir, name))) return false;
          records.delete(name.slice(0, 16));
          out.removed += 1;
          return true;
        } catch (err) {
          if (err.code !== 'ENOENT') note(err);
          return false;
        }
      };
      const files = [];
      const folders = [];
      for (const key of await fs.readdir(root)) {
        if (!PROJECT_KEY.test(key)) continue;
        const dir = path.join(root, key);
        const st = await fs.lstat(dir).catch(() => null);
        if (!st?.isDirectory() || !isMine(st)) continue; // a symlink, a file or a foreign folder is never followed or counted
        folders.push({ key, dir });
        let names;
        try {
          names = await fs.readdir(dir);
        } catch (err) {
          note(err);
          out.failed = true; // this folder's files are missing from the total
          continue;
        }
        for (const name of names) {
          const isTmp = TMP_NAME.test(name);
          if (!isTmp && !FILE_NAME.test(name)) continue;
          const f = await fs.lstat(path.join(dir, name)).catch(() => null);
          if (!f?.isFile() || !isMine(f) || f.nlink !== 1) continue;
          const expired = t - f.mtimeMs > (isTmp ? TMP_MAX_AGE : keepMs);
          if (!(expired && (await drop(dir, name))) && !isTmp) files.push({ dir, name, size: f.size, at: f.mtimeMs }); // one that would not go still counts
        }
      }
      let total = files.reduce((n, f) => n + f.size, 0);
      let count = files.length;
      const over = () => total + need > TOTAL_MAX || count + (need ? 1 : 0) > FILES_MAX;
      files.sort((a, b) => a.at - b.at); // oldest first
      for (const f of files) {
        if (!over() || t - f.at < EVICT_MIN_AGE) break; // sorted: every later file is younger than the first one that is too young
        if (await drop(f.dir, f.name)) {
          total -= f.size;
          count -= 1;
        }
      }
      for (const { key, dir } of folders) {
        if (key === writing) continue;
        try {
          await removeOwnDir(dir); // an empty folder only (a non-empty one stays), looked at with lstat and never followed (R3 F4)
        } catch (err) {
          note(err); // swapped for a link or a file since it was listed: left alone, a code in the log
        }
      }
      out.total = total;
      out.full = over();
    } catch (err) {
      note(err);
      out.failed = true;
    }
    return out;
  }

  /** Steps 5 to 11 of the upload; `buf` is a Buffer (the decoded body of an upload, or the bytes the file chooser read). */
  async function store({ pane, key, name, buf }) {
    if (!Buffer.isBuffer(buf)) return fail(400, 'invalid');
    if (buf.length > MAX_BYTES) return fail(413, 'too-big');
    const kind = sniff(buf, name);
    if (kind.error) return fail(kind.error === 'empty' ? 400 : 415, kind.error);
    let dir;
    try {
      const root = rootDir();
      await ensureDir(root);
      dir = await fs.realpath(await ensureDir(path.join(root, key)));
    } catch (err) {
      note(err);
      return isDiskFull(err) ? fail(507, 'disk-full') : fail(409, 'folder-unsafe');
    }
    const id = crypto.randomBytes(8).toString('hex');
    const file = `${id}.${kind.ext}`;
    const target = path.join(dir, file);
    if (!PATH_OK.test(target)) return fail(409, 'path-unusable');
    const swept = await sweep(buf.length);
    if (swept.failed) return fail(507, 'disk-full'); // the caps could not be checked: refuse rather than write past them
    if (swept.full) return fail(507, 'storage-full');
    try {
      await writeAtomic(dir, file, buf, { mode: 0o600 }); // unlinks its temp file when it fails
    } catch (err) {
      note(err);
      return isDiskFull(err) ? fail(507, 'disk-full') : fail(500, 'write-failed');
    }
    records.set(id, { id, pane, key, path: target, type: kind.type, size: buf.length, at: now(), sent: false });
    if (records.size > RECORDS_MAX) records.delete(records.keys().next().value);
    return { status: 200, body: { id, type: kind.type, size: buf.length } };
  }

  function stop() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  /**
   * The admission every save passes, whichever door it came through (the upload route, or the file chooser's reads): the pane and key
   * shapes, the rate limit and the one save at a time. `buf()` makes the bytes only once the save is admitted.
   */
  async function admitted({ pane, key, name }, buf) {
    if (typeof pane !== 'string' || !PANE_ID.test(pane)) return fail(404, 'not_found');
    if (typeof key !== 'string' || !PROJECT_KEY.test(key)) return fail(409, 'no-project');
    const t = now();
    while (stamps.length && t - stamps[0] >= 60_000) stamps.shift();
    if (inflight || stamps.length >= UPLOADS_PER_MIN) return fail(429, 'busy'); // checked and set before any await: two calls cannot both pass
    stamps.push(t);
    inflight = true;
    writing = key;
    try {
      return await store({ pane, key, name, buf: buf() });
    } finally {
      writing = null;
      inflight = false;
    }
  }

  return {
    /** Design 3.2 steps 4 to 11. `pane` and `key` come from nika's own snapshot, never from the request; resolves `{ status, body }`. */
    async save({ pane, key, name, data }) {
      const bad = checkUploadBody({ name, data });
      if (bad) return bad;
      return admitted({ pane, key, name }, () => Buffer.from(data, 'base64'));
    },

    /** The same save for bytes the server read itself (the file chooser, W2-T6): `bytes` is a Buffer; every rule of save() applies. */
    saveBytes({ pane, key, name, bytes }) {
      return admitted({ pane, key, name }, () => bytes);
    },

    /** The send's file check (design 4.3): an unsent id this process issued for this pane, whose file is still the one nika wrote. */
    async lookup(pane, id) {
      const r = records.get(id);
      if (!r || r.pane !== pane || r.sent) return null;
      try {
        const { handle, st } = await openRegular(r.path); // O_NOFOLLOW, regular, owned by the user, one link
        await handle.close(); // the content is never read back
        if (st.size !== r.size || !(await unmoved(r.path))) return null; // a folder on the way became a link
        return { id: r.id, path: r.path, type: r.type, size: r.size };
      } catch (err) {
        note(err);
        return null;
      }
    },

    /** Deletes an unsent file of this pane now. false for unknown, another pane's, sent, already gone or refused (no oracle). */
    async remove(pane, id) {
      const r = records.get(id);
      if (!r || r.pane !== pane || r.sent) return false;
      try {
        const dir = path.dirname(r.path);
        if (!(await unmoved(dir))) return false; // removeOwnFile looks at the last folder only
        const removed = await removeOwnFile(dir, path.basename(r.path));
        records.delete(id);
        return removed;
      } catch (err) {
        note(err); // a symlink or a second link: the file stays for pruning, which refuses it again
        return false;
      }
    },

    /** After the Enter: these files are Claude's now and can no longer be looked up or removed (pruning still ages them out). */
    markSent(ids) {
      for (const id of ids ?? []) {
        const r = records.get(id);
        if (r) r.sent = true;
      }
    },

    async prune({ need = 0 } = {}) {
      const { removed, total } = await sweep(need);
      return { removed, total };
    },

    /** Prunes now and every 24 h (the timer is unref'd). Resolves when the first prune is done; it never rejects. */
    start() {
      stop();
      timer = setTimer(() => sweep(), PRUNE_EVERY); // sweep never rejects
      timer?.unref?.();
      return sweep().then(() => {});
    },

    stop,
  };
}
